// src/engine/manga-engine.js — Core orchestration logic
// Coordinates panel detection, OCR, TTS, and cinematic playback.
// Smooth scrolling with ambient audio and scene narration.
// NO Chrome APIs — pure JS for mobile reuse.

/**
 * MangaEngine — main orchestrator for the cinematic manga reading experience.
 */
class MangaEngine {
  constructor(config = {}) {
    this.config = {
      voiceIndex: config.voiceIndex ?? 0,
      scrollDuration: config.scrollDuration ?? 2000,  // ms for smooth scroll between panels
      panelHoldTime: config.panelHoldTime ?? 3000,    // ms to hold on each panel
      zoomEnabled: config.zoomEnabled ?? true,
      readingDirection: config.readingDirection ?? 'ltr',
      layoutMode: config.layoutMode ?? 'paged',
      language: config.language ?? 'eng',
    };

    this.tts = null;
    this.ocr = null;
    this.panelDetector = null;
    this.voiceAssigner = null;

    this.panels = [];
    this.voices = [];
    this.currentPanel = 0;
    this.currentText = '';
    this.isPlaying = false;
    this.isPaused = false;

    this._originalStyles = new Map();
    this._overlay = null;
    this._dimmedPanels = false;
    this._ttsProxy = null;
    this._ambientProxy = null;
    this._speechRate = 1.0;
    this._siteConfig = null;
    this._tapOverlay = null;
    this._ttsFailed = false; // set true if TTS is broken (context invalidated)
  }

  async initialize() {
    try {
      // Auto-detect site configuration if SiteAdapter is available
      if (window.SiteAdapter && !this._siteConfig) {
        try {
          const adapter = new window.SiteAdapter();
          this._siteConfig = adapter.detect();
          console.log('[MangaReader] SiteAdapter detected:', JSON.stringify(this._siteConfig));
          if (this._siteConfig.readingDirection && this._siteConfig.readingDirection !== 'auto') {
            this.config.readingDirection = this._siteConfig.readingDirection;
          }
          if (this._siteConfig.layoutMode && this._siteConfig.layoutMode !== 'auto') {
            this.config.layoutMode = this._siteConfig.layoutMode;
          }
          if (this._siteConfig.language && this._siteConfig.language !== 'auto') {
            this.config.language = this._siteConfig.language;
          }
        } catch (siteErr) {
          console.warn('[MangaReader] SiteAdapter failed (using defaults):', siteErr.message);
        }
      }

      this.tts = new window.TTSEngine({ rate: 1.0 });
      if (this._ttsProxy) {
        this.tts.setProxy(this._ttsProxy);
      }
      this.voices = await this.tts.getVoices();
      console.log(`[MangaReader] TTS ready — ${this.voices.length} voices available`);

      // Normalize language for OCR — pass through as-is; OCREngine handles mapping
      const ocrCfg = Object.assign({}, this._ocrConfig || {}, { language: this.config.language });
      console.log('[MangaReader] OCR config:', JSON.stringify({ language: this.config.language }));
      this.ocr = new window.OCREngine(ocrCfg);
      await this.ocr.initialize();

      console.log(`[MangaReader] Creating PanelDetector with layoutMode=${this.config.layoutMode}, dir=${this.config.readingDirection}`);
      this.panelDetector = new window.PanelDetector({
        readingDirection: this.config.readingDirection,
        layoutMode: this.config.layoutMode,
      });

      this.voiceAssigner = new window.VoiceAssigner({ strategy: 'single' });

      this.panels = await this.panelDetector.detect();
      this.emitStatus();
      console.log(`[MangaReader] Engine initialized — ${this.panels.length} panels (${this.config.layoutMode}, ${this.config.readingDirection})`);
      if (this.panels.length === 0) {
        console.warn('[MangaReader] WARNING: 0 panels detected! Check console for PanelDetector logs above.');
      }
    } catch (err) {
      console.error('[MangaReader] Engine initialization error:', err);
    }
  }

  setOCRConfig(ocrConfig) { this._ocrConfig = ocrConfig; }

  setTTSProxy(proxy) { this._ttsProxy = proxy; }

  setAmbientProxy(proxy) { this._ambientProxy = proxy; }

  setSiteConfig(config) {
    this._siteConfig = config;
    if (config.readingDirection) this.config.readingDirection = config.readingDirection;
    if (config.layoutMode) this.config.layoutMode = config.layoutMode;
    if (config.language) this.config.language = config.language;
  }

  setImageFetcher(fn) {
    if (this.ocr) this.ocr.setImageFetcher(fn);
    this._imageFetcher = fn;
  }

  setOCRProxy(fn) {
    if (this.ocr) this.ocr.setOCRProxy(fn);
    this._ocrProxy = fn;
  }

  // ============================================================
  //  PLAYBACK — smooth cinematic scroll with narration
  // ============================================================

  async play() {
    this.isPlaying = true;
    this.isPaused = false;

    this._createOverlay();
    this._updateOverlay('\u23f3 Detecting panels...');

    this.panels = await this.panelDetector.detect();
    this.emitStatus();

    if (this.panels.length === 0) {
      this._updateOverlay('\u26a0 No manga panels detected');
      await this._sleep(3000);
      this._removeOverlay();
      this.isPlaying = false;
      this.emitStatus();
      return;
    }

    this._updateOverlay(`\u25b6 Found ${this.panels.length} panels — starting`);
    if (this._ambientProxy) this._ambientProxy.init();
    this._createTapZones();

    for (let i = this.currentPanel; i < this.panels.length; i++) {
      if (!this.isPlaying) break;
      while (this.isPaused) await this._sleep(100);
      if (!this.isPlaying) break;

      this.currentPanel = i;
      const panel = this.panels[i];

      this.cacheOriginalStyle(panel.element);

      // --- 1. Smooth scroll to panel ---
      this._updateOverlay(`\u25b6 Panel ${i + 1} / ${this.panels.length}`);
      await this._smoothScrollTo(panel.element, this.config.scrollDuration);

      if (!this.isPlaying) break;

      // --- 2. Cinematic focus (dim + highlight + zoom) ---
      this._dimOtherPanels(panel.element);
      this._highlightPanel(panel.element);
      await this.zoomToPanel(panel.element);

      // --- 3. Try OCR for dialogue ---
      let text = '';
      try {
        text = await this.ocr.extractText(panel.element);
      } catch {
        text = '';
      }
      this.currentText = text;
      this.emitStatus();

      if (text.trim()) {
        // --- 4a. Dialogue found — narrate it ---
        this._updateOverlay(`\ud83d\udcac Panel ${i + 1} / ${this.panels.length}\n"${text.substring(0, 140)}"`);
        this._setAmbientMood('calm');
        if (!this._ttsFailed) {
          try {
            const voiceCount = this.voices.length || 1;
            const voiceIdx = this.voiceAssigner.assignVoice(panel.element, voiceCount);
            await this.tts.speak(text, voiceIdx);
          } catch (err) {
            const errStr = String(err?.message || err || '');
            console.warn('[MangaReader] TTS error on panel', i, errStr);
            if (errStr.includes('invalidated') || errStr.includes('port closed')) {
              console.warn('[MangaReader] TTS bridge is dead — falling back to timed display');
              this._ttsFailed = true;
            }
            await this._sleep(Math.max(2000, text.length * 60));
          }
        } else {
          // TTS is broken — show text for a readable duration
          await this._sleep(Math.max(2000, text.length * 60));
        }
      } else {
        // --- 4b. No dialogue — scene narration + ambient ---
        const sceneDesc = this._describeScene(panel, i);
        this.currentText = sceneDesc;
        this._updateOverlay(`\ud83c\udfac Panel ${i + 1} / ${this.panels.length}\n${sceneDesc}`);
        this.emitStatus();

        // Play ambient tone for the scene
        if (this._ambientProxy) this._ambientProxy.setMood(this._detectMood(panel.element));

        // Narrate the scene description
        if (!this._ttsFailed) {
          try {
            await this.tts.speak(sceneDesc, 0);
          } catch {
            this._ttsFailed = true;
            await this._sleep(this.config.panelHoldTime);
          }
        } else {
          await this._sleep(this.config.panelHoldTime);
        }
      }

      if (!this.isPlaying) break;

      // --- 5. Zoom out + restore ---
      await this._unzoomPanel(panel.element);
      this._unhighlightPanel(panel.element);
      this._undimOtherPanels();
      this.restoreOriginalStyle(panel.element);

      // Small breath between panels
      await this._sleep(500);
      this.emitStatus();
    }

    // --- Done ---
    this.isPlaying = false;
    if (this._ambientProxy) this._ambientProxy.stop();
    this._undimOtherPanels();
    this._removeTapZones();
    this._updateOverlay('\u2713 Finished reading');
    await this._sleep(2000);
    this._removeOverlay();
    this.emitStatus();
  }

  pause() {
    this.isPaused = true;
    if (this.tts) this.tts.pause();
    if (this._ambientProxy) this._ambientProxy.setMood('pause');
    this.emitStatus();
  }

  resume() {
    this.isPaused = false;
    if (this.tts) this.tts.resume();
    if (this._ambientProxy) this._ambientProxy.setMood('calm');
    this.emitStatus();
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentPanel = 0;
    this.currentText = '';
    if (this.tts) this.tts.stop();
    if (this._ambientProxy) this._ambientProxy.stop();
    this._undimOtherPanels();
    this._removeOverlay();
    this._removeTapZones();
    this.restoreAllStyles();
    this.emitStatus();
  }

  jumpToPanel(index) {
    if (index >= 0 && index < this.panels.length) {
      this.currentPanel = index;
      this.emitStatus();
    }
  }

  setSpeed(rate) {
    this._speechRate = rate;
    if (this.tts) this.tts.setRate(rate);
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentPanel: this.currentPanel,
      totalPanels: this.panels.length,
      currentText: this.currentText,
    };
  }

  // ============================================================
  //  SMOOTH SCROLLING
  // ============================================================

  /**
   * Smoothly scroll to center a panel in the viewport over a given duration.
   * Uses requestAnimationFrame for buttery animation.
   */
  async _smoothScrollTo(element, duration) {
    const rect = element.getBoundingClientRect();
    const targetY = window.scrollY + rect.top - (window.innerHeight / 2) + (rect.height / 2);
    const startY = window.scrollY;
    const distance = targetY - startY;

    if (Math.abs(distance) < 10) return; // Already there

    return new Promise((resolve) => {
      const startTime = performance.now();

      const step = (now) => {
        if (!this.isPlaying) { resolve(); return; }
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease in-out cubic for smooth feel
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        window.scrollTo(0, startY + distance * eased);

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(step);
    });
  }

  // ============================================================
  //  SCENE DESCRIPTION (when no dialogue found)
  // ============================================================

  /**
   * Generate a short scene narration based on panel position and image analysis.
   */
  _describeScene(panel, index) {
    const element = panel.element;
    const total = this.panels.length;

    // Analyze image colors to guess scene mood
    const mood = this._detectMood(element);
    const position = index / Math.max(total - 1, 1);

    // Position-based narrative beats (story structure)
    let beat = '';
    if (index === 0) {
      beat = 'The scene opens.';
    } else if (position < 0.15) {
      beat = 'The story begins to unfold.';
    } else if (position < 0.4) {
      beat = 'The tension builds.';
    } else if (position > 0.85 && index === total - 1) {
      beat = 'The chapter comes to a close.';
    } else if (position > 0.75) {
      beat = 'The climax approaches.';
    } else if (position > 0.5) {
      beat = 'The story deepens.';
    } else {
      beat = 'The scene continues.';
    }

    // Mood-based flavor
    const moodText = {
      dark: 'A dark, intense moment.',
      bright: 'A vibrant scene unfolds.',
      action: 'Action fills the panel!',
      calm: 'A quiet moment.',
      dramatic: 'Drama and emotion.',
    };

    return `${beat} ${moodText[mood] || 'The story progresses.'}`;
  }

  /**
   * Simple image color analysis to detect mood.
   * Samples pixels and returns a mood string.
   */
  _detectMood(imgElement) {
    try {
      const canvas = document.createElement('canvas');
      const size = 50; // Small sample for speed
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgElement, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      let totalR = 0, totalG = 0, totalB = 0, darkPixels = 0, brightPixels = 0;
      const pixelCount = size * size;

      for (let i = 0; i < data.length; i += 4) {
        totalR += data[i];
        totalG += data[i + 1];
        totalB += data[i + 2];
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < 60) darkPixels++;
        if (lum > 200) brightPixels++;
      }

      const avgR = totalR / pixelCount;
      const avgG = totalG / pixelCount;
      const avgB = totalB / pixelCount;
      const avgLum = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;

      const darkRatio = darkPixels / pixelCount;
      const brightRatio = brightPixels / pixelCount;

      // High contrast (lots of dark + bright) = action/dramatic
      if (darkRatio > 0.4 && brightRatio > 0.1) return 'action';
      if (darkRatio > 0.5) return 'dark';
      if (brightRatio > 0.5) return 'bright';
      if (avgR > avgB + 30 && avgLum < 150) return 'dramatic';
      return 'calm';
    } catch {
      return 'calm';
    }
  }

  // Ambient audio is now handled by the offscreen document via this._ambientProxy
  // (set from content.js). No AudioContext in MAIN world.

  // ============================================================
  //  ZOOM + VISUAL EFFECTS
  // ============================================================

  async zoomToPanel(element) {
    if (!this.config.zoomEnabled) return;
    element.style.transformOrigin = 'center center';

    if (window.gsap) {
      await new Promise((resolve) => {
        window.gsap.to(element, {
          scale: 1.12,
          duration: 0.8,
          ease: 'power2.out',
          onComplete: resolve,
        });
      });
    } else {
      element.style.transition = 'transform 0.8s ease';
      element.style.transform = 'scale(1.12)';
      await this._sleep(800);
    }
  }

  async _unzoomPanel(element) {
    if (!this.config.zoomEnabled) return;
    if (window.gsap) {
      await new Promise((resolve) => {
        window.gsap.to(element, {
          scale: 1,
          duration: 0.5,
          ease: 'power2.inOut',
          onComplete: resolve,
        });
      });
    } else {
      element.style.transform = 'scale(1)';
      await this._sleep(500);
    }
  }

  _dimOtherPanels(currentElement) {
    this.panels.forEach((p) => {
      if (p.element !== currentElement) {
        this.cacheOriginalStyle(p.element);
        p.element.style.transition = 'filter 0.6s ease, opacity 0.6s ease';
        p.element.style.filter = 'brightness(0.25) blur(2px)';
        p.element.style.opacity = '0.35';
      }
    });
    this._dimmedPanels = true;
  }

  _undimOtherPanels() {
    if (!this._dimmedPanels) return;
    this.panels.forEach((p) => {
      p.element.style.filter = '';
      p.element.style.opacity = '';
      p.element.style.transition = '';
    });
    this._dimmedPanels = false;
  }

  _highlightPanel(element) {
    element.style.transition = 'box-shadow 0.4s ease, outline 0.4s ease';
    element.style.boxShadow = '0 0 40px 12px rgba(233, 69, 96, 0.5)';
    element.style.outline = '3px solid #e94560';
    element.style.borderRadius = '4px';
    element.style.position = 'relative';
    element.style.zIndex = '10';
  }

  _unhighlightPanel(element) {
    element.style.boxShadow = '';
    element.style.outline = '';
    element.style.borderRadius = '';
    element.style.zIndex = '';
  }

  // ============================================================
  //  OVERLAY
  // ============================================================

  _createOverlay() {
    if (this._overlay) return;
    this._overlay = document.createElement('div');
    this._overlay.id = 'manga-reader-overlay';
    this._overlay.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99999',
      'background:rgba(26,26,46,0.92)', 'color:#eee',
      'border:2px solid #e94560', 'border-radius:12px',
      'padding:14px 18px', 'font-family:system-ui,sans-serif',
      'max-width:360px', 'font-size:13px', 'line-height:1.5',
      'box-shadow:0 4px 24px rgba(0,0,0,0.6)',
      'white-space:pre-wrap', 'pointer-events:none',
      'transition:opacity 0.3s ease',
    ].join(';');
    document.body.appendChild(this._overlay);
  }

  _updateOverlay(text) {
    if (!this._overlay) this._createOverlay();
    this._overlay.textContent = text;
  }

  _removeOverlay() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
  }

  // ============================================================
  //  DOM RESTORATION
  // ============================================================

  cacheOriginalStyle(element) {
    if (!this._originalStyles.has(element)) {
      this._originalStyles.set(element, element.getAttribute('style') || '');
    }
  }

  restoreOriginalStyle(element) {
    if (this._originalStyles.has(element)) {
      const original = this._originalStyles.get(element);
      if (original) {
        element.setAttribute('style', original);
      } else {
        element.removeAttribute('style');
      }
    }
  }

  restoreAllStyles() {
    this._originalStyles.forEach((style, el) => {
      if (style) {
        el.setAttribute('style', style);
      } else {
        el.removeAttribute('style');
      }
    });
    this._originalStyles.clear();
  }

  emitStatus() {
    try {
      document.dispatchEvent(new CustomEvent('mangareader:status', { detail: this.getStatus() }));
    } catch { /* ignore */ }
  }

  // ============================================================
  //  TAP-ZONE NAVIGATION
  // ============================================================

  _createTapZones() {
    if (this._tapOverlay) return;
    this._tapOverlay = document.createElement('div');
    this._tapOverlay.id = 'manga-reader-tapzones';
    this._tapOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99998;pointer-events:none;';

    const makeZone = (side) => {
      const zone = document.createElement('div');
      zone.style.cssText = `position:absolute;top:0;${side}:0;width:25%;height:100%;pointer-events:auto;cursor:pointer;`;
      zone.dataset.side = side;
      zone.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._handleTapZone(side);
      });
      return zone;
    };

    this._tapOverlay.appendChild(makeZone('left'));
    this._tapOverlay.appendChild(makeZone('right'));
    document.body.appendChild(this._tapOverlay);
  }

  _removeTapZones() {
    if (this._tapOverlay) {
      this._tapOverlay.remove();
      this._tapOverlay = null;
    }
  }

  _handleTapZone(side) {
    if (!this.isPlaying || this.panels.length === 0) return;

    const isNext = (this.config.readingDirection === 'rtl') ? (side === 'left') : (side === 'right');

    if (isNext && this.currentPanel < this.panels.length - 1) {
      this.currentPanel++;
      this.emitStatus();
    } else if (!isNext && this.currentPanel > 0) {
      this.currentPanel--;
      this.emitStatus();
    }
  }

  // ============================================================
  //  AMBIENT MOOD HELPER
  // ============================================================

  _setAmbientMood(mood) {
    if (this._ambientProxy) this._ambientProxy.setMood(mood);
  }

  async destroy() {
    this.stop();
    this._removeOverlay();
    this._removeTapZones();
    if (this._ambientProxy) this._ambientProxy.stop();
    if (this.panelDetector) this.panelDetector.destroy();
    if (this.ocr) await this.ocr.destroy();
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

if (typeof window !== 'undefined') {
  window.MangaEngine = MangaEngine;
}
