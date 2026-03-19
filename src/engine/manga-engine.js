// src/engine/manga-engine.js — Core orchestration logic
// Coordinates panel detection, OCR, TTS, and cinematic playback.
// Smooth scrolling with ambient audio and scene narration.
// NO Chrome APIs — pure JS for mobile reuse.

/**
 * MangaEngine — main orchestrator for the cinematic manga reading experience.
 */
class MangaEngine {
  static _dbg(...args) { 
    if (typeof window !== 'undefined' && window.__mangaReaderDebug) console.log('[MangaReader]', ...args); 
  }

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
    this._ttsFailed = false;
    this._voiceBIndex = -1; // -1 = same as voice A (single mode)
    this._scrollProgress = 0;
    this._narratedCount = 0;
    this._debugPanel = null;
    this._debugLog = [];       // Array of {type, text, mood, timestamp}
    this._activeEffects = [];  // Track active visual effects for cleanup
    this._characterRegistry = null;
    this._tabCaptureFn = null;
  }

  async initialize() {
    try {
      // Auto-detect site configuration if SiteAdapter is available
      if (window.SiteAdapter && !this._siteConfig) {
        try {
          const adapter = new window.SiteAdapter();
          this._siteConfig = adapter.detect();
          MangaEngine._dbg('SiteAdapter detected:', JSON.stringify(this._siteConfig));
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
      MangaEngine._dbg(`TTS ready — ${this.voices.length} voices`);

      const ocrCfg = Object.assign({}, this._ocrConfig || {}, { language: this.config.language });
      MangaEngine._dbg('OCR config:', JSON.stringify({ language: this.config.language }));
      this.ocr = new window.OCREngine(ocrCfg);
      await this.ocr.initialize();

      MangaEngine._dbg(`Creating PanelDetector: mode=${this.config.layoutMode}, dir=${this.config.readingDirection}`);
      this.panelDetector = new window.PanelDetector({
        readingDirection: this.config.readingDirection,
        layoutMode: this.config.layoutMode,
      });

      this.voiceAssigner = new window.VoiceAssigner({
        strategy: this._voiceBIndex >= 0 ? 'character' : 'single',
      });

      // Create character registry for color-signature-based voice assignment
      if (window.CharacterRegistry && this._voiceBIndex >= 0) {
        this._characterRegistry = new window.CharacterRegistry({
          availableVoices: Math.min(this.voices.length || 2, 4),
        });
        this.voiceAssigner.setCharacterRegistry(this._characterRegistry);
        MangaEngine._dbg('CharacterRegistry initialized');
      }

      // For paged mode, detect panels upfront.
      // For webtoon continuous mode, skip — images are found during scroll.
      if (this.config.layoutMode !== 'webtoon') {
        this.panels = await this.panelDetector.detect();
      } else {
        this.panels = [];
        MangaEngine._dbg('Webtoon mode — skipping upfront panel detection');
      }
      this.emitStatus();
      console.log(`[MangaReader] Engine initialized — ${this.config.layoutMode} mode (${this.config.readingDirection})`);
      if (this.panels.length === 0 && this.config.layoutMode !== 'webtoon') {
        console.warn('[MangaReader] WARNING: 0 panels detected! Check console for PanelDetector logs above.');
      }
    } catch (err) {
      console.error('[MangaReader] Engine initialization error:', err);
    }
  }

  setOCRConfig(ocrConfig) { this._ocrConfig = ocrConfig; }

  setTTSProxy(proxy) { this._ttsProxy = proxy; }

  setAmbientProxy(proxy) { this._ambientProxy = proxy; }

  setTabCaptureFn(fn) { this._tabCaptureFn = fn; }

  /** Enable or disable enhanced OCR. Pass null to revert to default. */
  setEnhancedOCRFn(fn) { if (this.ocr) this.ocr.setEnhancedOCRFn(fn || null); }

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


  // ============================================================
  //  PLAYBACK — smooth cinematic scroll with narration
  // ============================================================

  async play() {
    this.isPlaying = true;
    this.isPaused = false;
    this._scrollProgress = 0;
    this._narratedCount = 0;

    this._createOverlay();
    this._createDebugPanel();
    // Hook into OCR for raw text debug logging
    if (window.__mangaReaderDebug) {
      window.__mangaReaderOcrDebugHook = (raw, clean) => {
        this._debugAddEntry('ocr-raw', raw.substring(0, 300), 'none', `Cleaned: ${clean.substring(0, 150)}`);
      };
    }
    if (this._ambientProxy) this._ambientProxy.init();
    // Tap zones only for paged mode — webtoon needs free scrolling
    if (this.config.layoutMode !== 'webtoon') {
      this._createTapZones();
    }
    this._bindKeyboard();

    if (this.config.layoutMode === 'webtoon') {
      this._updateOverlay('\u25b6 Starting continuous scroll...');
      await this._playContinuousScroll();
    } else {
      this._updateOverlay('\u23f3 Detecting panels...');
      this.panels = await this.panelDetector.detect();
      this.emitStatus();

      if (this.panels.length === 0) {
        this._updateOverlay('\u26a0 No manga panels detected');
        await this._sleep(3000);
      } else {
        this._updateOverlay(`\u25b6 Found ${this.panels.length} panels — starting`);
        await this._playPanelByPanel();
      }
    }

    // --- Done (both modes) ---
    this.isPlaying = false;
    if (this._ambientProxy) this._ambientProxy.stop();
    this._undimOtherPanels();
    this._removeFloatingControls();
    this._cleanupActiveEffects();
    this._removeTapZones();
    this._unbindKeyboard();
    this._updateOverlay('\u2713 Finished reading');
    await this._sleep(2000);
    this._removeOverlay();
    this.emitStatus();
  }

  /**
   * Panel-by-panel playback for paged manga (non-webtoon).
   */
  async _playPanelByPanel() {
    for (let i = this.currentPanel; i < this.panels.length; i++) {
      if (!this.isPlaying) break;
      while (this.isPaused) await this._sleep(100);
      if (!this.isPlaying) break;

      this.currentPanel = i;
      const panel = this.panels[i];

      this.cacheOriginalStyle(panel.element);

      this._updateOverlay(`\u25b6 Panel ${i + 1} / ${this.panels.length}`);
      await this._smoothScrollTo(panel.element, this.config.scrollDuration);

      if (!this.isPlaying) break;

      this._dimOtherPanels(panel.element);
      this._highlightPanel(panel.element);
      await this.zoomToPanel(panel.element);

      let text = '';
      let bubbles = [];
      const useCharacterVoice = this.voiceAssigner.config.strategy === 'character' && this._characterRegistry;

      if (useCharacterVoice) {
        try {
          bubbles = await this.ocr.extractBubbles(panel.element);
          text = bubbles.map(b => b.text).join(' ');
        } catch { bubbles = []; text = ''; }
      } else {
        try { text = await this.ocr.extractText(panel.element); } catch { text = ''; }
      }

      this.currentText = text;
      this.emitStatus();

      // Detect mood for effects & debug
      const mood = this._detectMood(panel.element);

      if (text.trim()) {
        this._debugAddEntry('ocr', text, mood);
        this._updateOverlay(`\ud83d\udcac Panel ${i + 1} / ${this.panels.length}\n"${text.substring(0, 140)}"`);
        // this._setAmbientMood(mood);  // DISABLED: user prefers no ambient sounds

        // Trigger SFX for intense moods
        if (mood === 'fire' || mood === 'lightning' || mood === 'impact' || mood === 'action') {
          this._triggerSFX(mood);
        }

        if (!this._ttsFailed) {
          try {
            if (useCharacterVoice && bubbles.length > 0) {
              // Per-bubble character voice assignment
              for (const bubble of bubbles) {
                if (!this.isPlaying) break;
                let voiceIdx = await this.voiceAssigner.assignVoiceForBubble(panel.element, bubble.region, this.voices.length);
                if (voiceIdx === 1 && this._voiceBIndex >= 0) voiceIdx = this._voiceBIndex;
                this._debugAddEntry('bubble', bubble.text, mood, `Voice ${voiceIdx}, region: x=${bubble.region.x} y=${bubble.region.y}`);
                await this.tts.speak(bubble.text, voiceIdx);
              }
            } else {
              const voiceCount = this.voices.length || 1;
              let voiceIdx = this.voiceAssigner.assignVoice(panel.element, voiceCount);
              if (voiceIdx === 1 && this._voiceBIndex >= 0) voiceIdx = this._voiceBIndex;
              await this.tts.speak(text, voiceIdx);
            }
          } catch (err) {
            const errStr = String(err?.message || err || '');
            console.warn('[MangaReader] TTS error on panel', i, errStr);
            if (errStr.includes('invalidated') || errStr.includes('port closed')) {
              this._ttsFailed = true;
            }
            await this._sleep(Math.max(2000, text.length * 60));
          }
        } else {
          await this._sleep(Math.max(2000, text.length * 60));
        }
      } else {
        const sceneDesc = this._describeScene(panel, i);
        this.currentText = sceneDesc;
        this._debugAddEntry('ocr', '(no text) ' + sceneDesc, mood);
        this._updateOverlay(`\ud83c\udfac Panel ${i + 1} / ${this.panels.length}\n${sceneDesc}`);
        this.emitStatus();

        // this._setAmbientMood(mood);  // DISABLED: user prefers no ambient sounds
        if (mood === 'fire' || mood === 'lightning' || mood === 'impact' || mood === 'action') {
          this._triggerSFX(mood);
        }

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

      await this._unzoomPanel(panel.element);
      this._unhighlightPanel(panel.element);
      this._undimOtherPanels();
      this.restoreOriginalStyle(panel.element);

      // Gutter scan: look for speech bubbles between this panel and the next
      if (i < this.panels.length - 1 && this.isPlaying) {
        const nextPanel = this.panels[i + 1];
        const knownTexts = new Set(text ? [text] : []);
        try {
          const gutterText = await this._scanGutter(panel, nextPanel, knownTexts);
          if (gutterText.trim()) {
            this.currentText = gutterText;
            this._debugAddEntry('gutter', gutterText, 'calm', `Between panels ${i + 1} and ${i + 2}`);
            this._updateOverlay(`\ud83d\udcac Gutter: "${gutterText.substring(0, 100)}"`);
            this.emitStatus();

            if (!this._ttsFailed) {
              try {
                await this.tts.speak(gutterText, 0);
              } catch { /* fall through */ }
            }
          } else {
            this._debugAddEntry('gutter', '(empty)', 'none', `Between panels ${i + 1} and ${i + 2}`);
          }
        } catch (err) {
          MangaEngine._dbg('Gutter scan error:', err.message);
        }
      }

      await this._sleep(500);
      this.emitStatus();
    }
  }

  /**
   * Continuous narration for webtoon — user scrolls, extension narrates.
   * Fires ONLY after scrolling stops (scrollend or 500ms debounce).
   * Uses Kavita's "closest image to viewport top" pattern.
   */
  async _playContinuousScroll() {
    const narratedSrcs = new Set(); // track by URL — SPA elements get replaced
    this._narrationBusy = false;

    const pageHeight = () => Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    // Mark images already above viewport as done
    document.querySelectorAll('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.bottom < 0 && img.src) narratedSrcs.add(img.src);
    });

    MangaEngine._dbg(`Companion mode started at y=${window.scrollY}`);
    this._createFloatingControls();
    this._updateOverlay('\u25b6 Scroll to read \u2014 narration active');

    // Core: fire narration after scroll settles
    const triggerNarration = () => {
      if (!this.isPlaying || this.isPaused || this._narrationBusy) return;

      const maxScroll = Math.max(pageHeight() - window.innerHeight, 1);
      this._scrollProgress = Math.round((window.scrollY / maxScroll) * 100);
      this._forceLazyLoadAhead();
      this._updateFloatingStatus();
      this.emitStatus();

      const img = this._findCurrentImage(narratedSrcs);
      if (!img) {
        MangaEngine._dbg('Scroll settled — no naratable image in view');
        return;
      }

      const imgSrc = img.src || img.dataset?.src;
      MangaEngine._dbg(`Scroll settled — narrating ${imgSrc?.slice(-50) || 'unknown'}`);
      narratedSrcs.add(imgSrc);
      this._narratedCount++;
      this.currentPanel = this._narratedCount;
      this._narrationBusy = true;

      const safetyTimer = setTimeout(() => {
        if (this._narrationBusy) {
          MangaEngine._dbg('Safety timeout — releasing _narrationBusy');
          this._narrationBusy = false;
        }
      }, 90000);

      this._narratePanel(img).then(() => {
        clearTimeout(safetyTimer);
        this._narrationBusy = false;
        this._updateFloatingStatus();
        this.emitStatus();
      }).catch(err => {
        clearTimeout(safetyTimer);
        MangaEngine._dbg('Narration error:', err?.message || err);
        this._narrationBusy = false;
      });
    };

    // 500ms debounce — fires after scrolling stops (covers Safari where scrollend is unreliable)
    let scrollDebounce = null;
    const onScroll = () => {
      clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(triggerNarration, 500);
    };

    // Native scrollend where available (Chrome/Firefox) — no extra debounce needed
    const useScrollEnd = 'onscrollend' in window;
    if (useScrollEnd) {
      window.addEventListener('scrollend', triggerNarration, { passive: true });
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // Trigger once for content already in view (1s grace period, Kavita pattern)
    const initialTimer = setTimeout(triggerNarration, 1000);

    // Thin keepalive loop — just handles pause and status, no detection work
    while (this.isPlaying) {
      while (this.isPaused) {
        await this._sleep(200);
        if (!this.isPlaying) break;
      }
      this._updateFloatingStatus();
      this.emitStatus();
      await this._sleep(1000);
    }

    // Cleanup
    clearTimeout(scrollDebounce);
    clearTimeout(initialTimer);
    if (useScrollEnd) window.removeEventListener('scrollend', triggerNarration);
    window.removeEventListener('scroll', onScroll);
    this._removeFloatingControls();
  }

  /**
   * Find the manga image currently most in view.
   * Picks the naratable image with the smallest |rect.top| — closest to viewport top.
   * Mirrors Kavita's findClosestVisibleImage() pattern.
   *
   * @param {Set<string>} excludeSrcs - already-narrated src URLs to skip
   */
  _findCurrentImage(excludeSrcs = new Set()) {
    let closest = null;
    let minDist = Infinity;
    const vh = window.innerHeight;

    for (const img of document.querySelectorAll('img')) {
      // Handle both src and data-src (lazy-loaded images)
      const src = img.src || img.dataset?.src;
      if (!src || excludeSrcs.has(src)) continue;
      if (!this._isNarratableImage(img)) continue;

      const rect = img.getBoundingClientRect();

      // Must be horizontally within the content area
      if (rect.right < 0 || rect.left > window.innerWidth) continue;
      // Must be at least partially visible vertically
      if (rect.bottom < 0 || rect.top > vh) continue;

      // Distance from viewport top — image closest to top wins
      const dist = Math.abs(rect.top);
      if (dist < minDist) {
        minDist = dist;
        closest = img;
      }
    }

    if (closest) {
      MangaEngine._dbg(`_findCurrentImage found: ${closest.src || closest.dataset?.src}`.substring(0, 100));
    } else {
      MangaEngine._dbg('_findCurrentImage: No naratable image found in viewport');
    }
    return closest;
  }

  /**
   * Narrate a single panel: highlight, OCR, TTS, animate, unhighlight.
   */
  async _narratePanel(imgElement) {
    // Cancel any speech still playing from the previous panel
    if (this.tts) this.tts.stop();

    MangaEngine._dbg(`_narratePanel starting with image: ${imgElement?.src?.substring(0, 60) || 'unknown'}`);

    this.cacheOriginalStyle(imgElement);
    MangaEngine._dbg('Step 1: cacheOriginalStyle done');

    this._animatePanel(imgElement, 'in');
    MangaEngine._dbg('Step 2: _animatePanel done');

    // Detect mood early for debug + SFX
    const mood = this._detectMood(imgElement);
    MangaEngine._dbg(`Step 3: mood detected = ${mood}`);

    this._debugAddEntry('mood', `Panel mood: ${mood}`, mood);
    MangaEngine._dbg('Step 4: debugAddEntry done');

    // Set ambient sound based on mood
    // this._setAmbientMood(mood);  // DISABLED: user prefers no ambient sounds

    // Trigger SFX for intense moods
    if (mood === 'fire' || mood === 'lightning' || mood === 'impact' || mood === 'action') {
      this._triggerSFX(mood);
    }

    MangaEngine._dbg('Step 5: about to call OCR');

    let text = '';
    let bubbles = [];
    const useCharacterVoice = this.voiceAssigner.config.strategy === 'character' && this._characterRegistry;

    if (useCharacterVoice) {
      try {
        MangaEngine._dbg('Step 5a: calling extractBubbles');
        bubbles = await this.ocr.extractBubbles(imgElement);
        MangaEngine._dbg(`Step 5b: extractBubbles returned ${bubbles.length} bubbles`);
        text = bubbles.map(b => b.text).join(' ');
      } catch (err) {
        MangaEngine._dbg('extractBubbles error:', err?.message || err);
        bubbles = [];
        text = '';
      }
    } else {
      try {
        MangaEngine._dbg('Step 5c: calling extractText');
        text = await this.ocr.extractText(imgElement);
        MangaEngine._dbg(`Step 5d: extractText returned: "${text.substring(0, 60)}"`);
      } catch (err) {
        MangaEngine._dbg('extractText error:', err?.message || err);
        text = '';
      }
    }

    this.currentText = text;
    this._scrollProgress = this._scrollProgress || 0;
    this.emitStatus();

    if (text.trim()) {
      this._debugAddEntry('ocr', text, mood);
      this._updateOverlay(`\ud83d\udcac "${text.substring(0, 140)}"`);

      if (!this._ttsFailed) {
        try {
          if (useCharacterVoice && bubbles.length > 0) {
            for (const bubble of bubbles) {
              if (!this.isPlaying) break;
              let voiceIdx = await this.voiceAssigner.assignVoiceForBubble(imgElement, bubble.region, this.voices.length);
              if (voiceIdx === 1 && this._voiceBIndex >= 0) voiceIdx = this._voiceBIndex;
              this._debugAddEntry('bubble', bubble.text, mood, `Voice ${voiceIdx}, region: x=${bubble.region.x} y=${bubble.region.y}`);
              await this.tts.speak(bubble.text, voiceIdx);
            }
          } else {
            const voiceCount = this.voices.length || 1;
            let voiceIdx = this.voiceAssigner.assignVoice(imgElement, voiceCount);
            if (voiceIdx === 1 && this._voiceBIndex >= 0) voiceIdx = this._voiceBIndex;
            await this.tts.speak(text, voiceIdx);
          }
        } catch (err) {
          const errStr = String(err?.message || err || '');
          if (errStr.includes('invalidated') || errStr.includes('port closed')) {
            this._ttsFailed = true;
          }
          await this._sleep(Math.max(1500, text.length * 50));
        }
      } else {
        await this._sleep(Math.max(1500, text.length * 50));
      }
    } else {
      this._debugAddEntry('ocr', '(no text)', mood);
      this._updateOverlay(`\ud83c\udfac ${this._narratedCount} panels read — ${this._scrollProgress}%`);
      await this._sleep(600);
    }

    this._animatePanel(imgElement, 'out');
    await this._sleep(400);
    this.restoreOriginalStyle(imgElement);
  }

  /**
   * Apply mood-specific manga visual effects on or around a panel.
   * Effects: fire glow, lightning flash, impact shake, action lines, etc.
   */
  _applyMoodEffect(element, mood) {
    this._cleanupActiveEffects();
    this._debugAddEntry('effect', `Applying ${mood} visual effect`, mood);

    switch (mood) {
      case 'fire':
        this._effectFire(element);
        break;
      case 'lightning':
        this._effectLightning(element);
        break;
      case 'impact':
        this._effectImpact(element);
        break;
      case 'action':
        this._effectActionLines(element);
        break;
      case 'dramatic':
        this._effectDramatic(element);
        break;
      case 'dark':
        this._effectDark(element);
        break;
      default:
        // calm/bright — just the standard glow
        break;
    }
  }

  /** Fire effect: pulsing orange-red glow overlay */
  _effectFire(element) {
    const overlay = document.createElement('div');
    overlay.className = 'manga-fx-fire';
    const rect = element.getBoundingClientRect();
    overlay.style.cssText = [
      'position:fixed', `top:${rect.top}px`, `left:${rect.left}px`,
      `width:${rect.width}px`, `height:${rect.height}px`,
      'pointer-events:none', 'z-index:11', 'border-radius:4px',
      'background:linear-gradient(0deg, rgba(255,69,0,0.3) 0%, rgba(255,140,0,0.15) 40%, transparent 70%)',
      'animation:mangaFirePulse 0.8s ease-in-out infinite alternate',
    ].join(';');
    document.body.appendChild(overlay);
    this._activeEffects.push(overlay);

    // Inject keyframes if not already present
    this._injectFxStyles();

    // Ember particles
    for (let i = 0; i < 6; i++) {
      const ember = document.createElement('div');
      ember.className = 'manga-fx-ember';
      const x = rect.left + Math.random() * rect.width;
      const startY = rect.bottom - 10;
      ember.style.cssText = [
        'position:fixed', `left:${x}px`, `top:${startY}px`,
        'width:4px', 'height:4px', 'border-radius:50%',
        'background:#ff6b00', 'pointer-events:none', 'z-index:12',
        `animation:mangaEmberRise ${1.5 + Math.random()}s ease-out ${i * 0.2}s infinite`,
        'opacity:0.8',
      ].join(';');
      document.body.appendChild(ember);
      this._activeEffects.push(ember);
    }

    element.style.boxShadow = '0 0 40px 15px rgba(255,69,0,0.5), 0 0 80px 30px rgba(255,140,0,0.2)';
  }

  /** Lightning effect: white-blue flash + electric arc overlay */
  _effectLightning(element) {
    const rect = element.getBoundingClientRect();

    // Flash overlay
    const flash = document.createElement('div');
    flash.className = 'manga-fx-lightning';
    flash.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100vw', 'height:100vh',
      'pointer-events:none', 'z-index:12',
      'background:rgba(180,220,255,0.3)',
      'animation:mangaLightningFlash 0.15s ease-out 3',
    ].join(';');
    document.body.appendChild(flash);
    this._activeEffects.push(flash);

    // Electric glow on panel
    element.style.boxShadow = '0 0 50px 20px rgba(0,200,255,0.6), 0 0 100px 40px rgba(100,180,255,0.2), inset 0 0 30px rgba(0,200,255,0.15)';

    // Jagged bolt SVG overlay
    const bolt = document.createElement('div');
    bolt.style.cssText = [
      'position:fixed', `top:${rect.top}px`, `left:${rect.left + rect.width * 0.3}px`,
      'width:40px', 'height:' + Math.min(rect.height, 200) + 'px',
      'pointer-events:none', 'z-index:13', 'opacity:0.9',
      'animation:mangaLightningFlash 0.2s ease-out 2',
    ].join(';');
    bolt.innerHTML = `<svg viewBox="0 0 40 200" style="width:100%;height:100%">
      <polyline points="20,0 8,50 25,55 5,110 22,115 0,200" stroke="#00d4ff" stroke-width="3" fill="none" opacity="0.9"/>
      <polyline points="22,10 12,45 27,50 10,100 24,108 5,180" stroke="#fff" stroke-width="1.5" fill="none" opacity="0.7"/>
    </svg>`;
    document.body.appendChild(bolt);
    this._activeEffects.push(bolt);
  }

  /** Impact/punch effect: screen shake + radial speed lines */
  _effectImpact(element) {
    const rect = element.getBoundingClientRect();

    // Screen shake
    document.body.style.animation = 'mangaShake 0.1s ease-in-out 4';
    setTimeout(() => { document.body.style.animation = ''; }, 500);

    // Radial speed lines (Japanese comic "concentration lines")
    const lineContainer = document.createElement('div');
    lineContainer.style.cssText = [
      'position:fixed', `top:${rect.top}px`, `left:${rect.left}px`,
      `width:${rect.width}px`, `height:${rect.height}px`,
      'pointer-events:none', 'z-index:11', 'overflow:hidden',
    ].join(';');

    const cx = rect.width / 2, cy = rect.height / 2;
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const line = document.createElement('div');
      const len = Math.max(rect.width, rect.height);
      line.style.cssText = [
        'position:absolute',
        `top:${cy}px`, `left:${cx}px`,
        `width:${len}px`, 'height:2px',
        'background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.6) 30%, transparent 100%)',
        `transform:rotate(${angle}rad)`, 'transform-origin:0 0',
        `animation:mangaSpeedLineIn 0.4s ease-out ${i * 0.02}s both`,
      ].join(';');
      lineContainer.appendChild(line);
    }
    document.body.appendChild(lineContainer);
    this._activeEffects.push(lineContainer);

    element.style.boxShadow = '0 0 30px 10px rgba(255,23,68,0.5)';
    element.style.filter = 'contrast(1.2) brightness(1.1)';
  }

  /** Action lines: horizontal speed/motion lines */
  _effectActionLines(element) {
    const rect = element.getBoundingClientRect();
    const container = document.createElement('div');
    container.style.cssText = [
      'position:fixed', `top:${rect.top}px`, `left:${rect.left}px`,
      `width:${rect.width}px`, `height:${rect.height}px`,
      'pointer-events:none', 'z-index:11', 'overflow:hidden',
    ].join(';');

    for (let i = 0; i < 8; i++) {
      const line = document.createElement('div');
      const y = (i / 8) * rect.height + Math.random() * 20;
      line.style.cssText = [
        'position:absolute', `top:${y}px`, 'left:-100%',
        'width:120%', `height:${1 + Math.random() * 2}px`,
        'background:linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)',
        `animation:mangaActionLine 0.6s ease-out ${i * 0.05}s both`,
      ].join(';');
      container.appendChild(line);
    }
    document.body.appendChild(container);
    this._activeEffects.push(container);

    element.style.boxShadow = '0 0 30px 10px rgba(233,69,96,0.5)';
  }

  /** Dramatic: vignette + warm tone */
  _effectDramatic(element) {
    const rect = element.getBoundingClientRect();
    const vignette = document.createElement('div');
    vignette.style.cssText = [
      'position:fixed', `top:${rect.top}px`, `left:${rect.left}px`,
      `width:${rect.width}px`, `height:${rect.height}px`,
      'pointer-events:none', 'z-index:11', 'border-radius:4px',
      'background:radial-gradient(ellipse at center, transparent 40%, rgba(100,30,0,0.3) 100%)',
    ].join(';');
    document.body.appendChild(vignette);
    this._activeEffects.push(vignette);

    element.style.boxShadow = '0 0 40px 12px rgba(255,99,72,0.4)';
    element.style.filter = 'contrast(1.1) saturate(1.2)';
  }

  /** Dark: deep shadow vignette */
  _effectDark(element) {
    const rect = element.getBoundingClientRect();
    const vignette = document.createElement('div');
    vignette.style.cssText = [
      'position:fixed', `top:${rect.top}px`, `left:${rect.left}px`,
      `width:${rect.width}px`, `height:${rect.height}px`,
      'pointer-events:none', 'z-index:11', 'border-radius:4px',
      'background:radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.4) 100%)',
    ].join(';');
    document.body.appendChild(vignette);
    this._activeEffects.push(vignette);

    element.style.boxShadow = '0 0 40px 12px rgba(108,92,231,0.4)';
  }

  /** Inject CSS keyframes for effects (once) */
  _injectFxStyles() {
    if (document.getElementById('manga-fx-styles')) return;
    const style = document.createElement('style');
    style.id = 'manga-fx-styles';
    style.textContent = `
      @keyframes mangaFirePulse {
        0% { opacity: 0.6; filter: brightness(1); }
        100% { opacity: 1; filter: brightness(1.3); }
      }
      @keyframes mangaEmberRise {
        0% { transform: translateY(0) scale(1); opacity: 0.8; }
        100% { transform: translateY(-120px) translateX(${Math.random() > 0.5 ? '' : '-'}${10 + Math.random() * 20}px) scale(0); opacity: 0; }
      }
      @keyframes mangaLightningFlash {
        0% { opacity: 1; }
        50% { opacity: 0; }
        100% { opacity: 0.8; }
      }
      @keyframes mangaShake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-4px) translateY(2px); }
        50% { transform: translateX(4px) translateY(-2px); }
        75% { transform: translateX(-2px) translateY(1px); }
      }
      @keyframes mangaSpeedLineIn {
        0% { opacity: 0; transform-origin: 0 0; }
        50% { opacity: 0.8; }
        100% { opacity: 0; }
      }
      @keyframes mangaActionLine {
        0% { left: -100%; opacity: 0; }
        50% { opacity: 0.6; }
        100% { left: 100%; opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  /** Remove all active visual effects */
  _cleanupActiveEffects() {
    for (const el of this._activeEffects) {
      try { el.remove(); } catch {}
    }
    this._activeEffects = [];
  }

  /**
   * Animate a panel with a cinematic glow effect.
   * 'in' = start animation, 'out' = end animation.
   */
  _animatePanel(element, phase) {
    if (phase === 'in') {
      this._injectFxStyles();
      element.style.transition = 'box-shadow 0.5s ease, outline 0.5s ease, filter 0.5s ease';
      element.style.boxShadow = '0 0 30px 8px rgba(233, 69, 96, 0.6), 0 0 60px 20px rgba(233, 69, 96, 0.2)';
      element.style.outline = '2px solid rgba(233, 69, 96, 0.8)';
      element.style.borderRadius = '4px';
      element.style.position = 'relative';
      element.style.zIndex = '10';
      element.style.filter = 'brightness(1.05) contrast(1.05)';

      // Apply mood-specific effect
      const mood = this._detectMood(element);
      this._applyMoodEffect(element, mood);
    } else {
      this._cleanupActiveEffects();
      element.style.transition = 'box-shadow 0.4s ease, outline 0.4s ease, filter 0.4s ease';
      element.style.boxShadow = '';
      element.style.outline = '';
      element.style.filter = '';
      element.style.zIndex = '';
    }
  }

  // ============================================================
  //  FLOATING ON-PAGE CONTROLS
  // ============================================================

  _createFloatingControls() {
    if (this._floatingBar) return;
    this._floatingBar = document.createElement('div');
    this._floatingBar.id = 'manga-reader-floating';
    this._floatingBar.style.cssText = [
      'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:99998', 'display:flex', 'align-items:center', 'gap:10px',
      'background:rgba(26,26,46,0.92)', 'border:2px solid #e94560',
      'border-radius:28px', 'padding:8px 18px',
      'font-family:system-ui,sans-serif', 'font-size:13px', 'color:#eee',
      'box-shadow:0 4px 24px rgba(0,0,0,0.5)',
      'user-select:none', 'backdrop-filter:blur(8px)',
    ].join(';');

    const btn = (label, title, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = [
        'border:none', 'background:transparent', 'color:#eee',
        'font-size:20px', 'cursor:pointer', 'padding:4px 6px',
        'border-radius:50%', 'line-height:1',
      ].join(';');
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };

    this._floatingPlayPauseBtn = btn('\u23f8', 'Pause', () => {
      this.isPaused ? this.resume() : this.pause();
    });
    const stopBtn = btn('\u23f9', 'Stop', () => this.stop());

    this._floatingStatus = document.createElement('span');
    this._floatingStatus.style.cssText = 'color:#a0a0b8;font-size:12px;min-width:100px;text-align:center;';
    this._floatingStatus.textContent = 'Scroll to read';

    this._floatingBar.appendChild(this._floatingPlayPauseBtn);
    this._floatingBar.appendChild(this._floatingStatus);
    this._floatingBar.appendChild(stopBtn);
    document.body.appendChild(this._floatingBar);
  }

  _updateFloatingStatus() {
    if (!this._floatingBar) return;
    if (this._floatingPlayPauseBtn) {
      this._floatingPlayPauseBtn.textContent = this.isPaused ? '\u25b6' : '\u23f8';
      this._floatingPlayPauseBtn.title = this.isPaused ? 'Resume' : 'Pause';
    }
    if (this._floatingStatus) {
      if (this.isPaused) {
        this._floatingStatus.textContent = 'Paused';
      } else if (this._narrationBusy) {
        this._floatingStatus.textContent = `Narrating... ${this._scrollProgress}%`;
      } else {
        this._floatingStatus.textContent = `${this._narratedCount} read \u2022 ${this._scrollProgress}%`;
      }
    }
  }

  _removeFloatingControls() {
    if (this._floatingBar) {
      this._floatingBar.remove();
      this._floatingBar = null;
      this._floatingPlayPauseBtn = null;
      this._floatingStatus = null;
    }
  }

  // ============================================================
  //  DEBUG PANEL (only shown when window.__mangaReaderDebug = true)
  // ============================================================

  _createDebugPanel() {
    if (!window.__mangaReaderDebug) return;
    if (this._debugPanel) return;

    const P = this._debugPanel = document.createElement('div');
    P.id = 'manga-reader-debug';
    P.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:340px', 'height:100vh',
      'z-index:100000', 'background:rgba(10,10,20,0.95)', 'color:#ccc',
      'font-family:Consolas,monospace', 'font-size:11px', 'line-height:1.4',
      'overflow-y:auto', 'padding:10px', 'border-left:2px solid #e94560',
      'box-shadow:-4px 0 20px rgba(0,0,0,0.5)', 'pointer-events:auto',
      'user-select:text',
    ].join(';');

    // Header bar
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;color:#e94560;font-size:13px;font-weight:bold;margin-bottom:8px;border-bottom:1px solid #333;padding-bottom:6px;';
    hdr.innerHTML = '<span>MANGA READER DEBUG</span>';

    // Copy All button
    const copyBtn = document.createElement('span');
    copyBtn.textContent = 'COPY';
    copyBtn.style.cssText = 'cursor:pointer;font-size:10px;padding:2px 6px;border:1px solid #e94560;border-radius:3px;color:#e94560;margin-right:20px;';
    copyBtn.addEventListener('click', () => this._debugCopyAll());
    hdr.appendChild(copyBtn);

    // Close button
    const closeBtn = document.createElement('span');
    closeBtn.textContent = 'X';
    closeBtn.style.cssText = 'cursor:pointer;color:#e94560;font-size:14px;font-weight:bold;';
    closeBtn.addEventListener('click', () => this._removeDebugPanel());
    hdr.appendChild(closeBtn);
    P.appendChild(hdr);

    // Helper: create collapsible section
    const makeSection = (title, id) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:8px;';
      const head = document.createElement('div');
      head.style.cssText = 'color:#e94560;font-size:11px;font-weight:bold;cursor:pointer;padding:3px 0;border-bottom:1px solid #222;';
      head.textContent = '\u25bc ' + title;
      const body = document.createElement('div');
      body.style.cssText = 'padding:4px;background:#16213e;border-radius:0 0 4px 4px;max-height:200px;overflow-y:auto;';
      head.addEventListener('click', () => {
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? 'block' : 'none';
        head.textContent = (collapsed ? '\u25bc ' : '\u25b6 ') + title;
      });
      wrap.appendChild(head);
      wrap.appendChild(body);
      P.appendChild(wrap);
      return body;
    };

    // 1. STATUS section
    this._debugStats = makeSection('STATUS', 'stats');

    // 2. CURRENT MOOD section
    this._debugMoodDisplay = makeSection('CURRENT MOOD', 'mood');

    // 3. OCR TEXT BANK — all discovered text
    this._debugOcrBank = makeSection('OCR TEXT BANK', 'ocrbank');

    // 4. BUBBLE MAP — per-bubble data
    this._debugBubbleMap = makeSection('BUBBLE MAP', 'bubbles');

    // 5. SOUND / SFX LOG
    this._debugSoundLog = makeSection('SOUNDS & SFX', 'sounds');

    // 6. CHARACTER REGISTRY
    this._debugCharSection = makeSection('CHARACTERS', 'chars');

    // 7. GUTTER SCAN LOG
    this._debugGutterLog = makeSection('GUTTER SCANS', 'gutter');

    // 8. FULL NARRATION LOG — the detailed event stream
    this._debugLogContainer = makeSection('NARRATION LOG', 'log');
    this._debugLogContainer.style.maxHeight = 'calc(100vh - 500px)';

    document.body.appendChild(P);
    this._updateDebugPanel();
  }

  _updateDebugPanel() {
    if (!this._debugPanel) return;

    // -- STATUS --
    const totalImages = document.querySelectorAll('img').length;
    const narratableImages = [...document.querySelectorAll('img')].filter(img => this._isNarratableImage(img)).length;
    if (this._debugStats) {
      this._debugStats.innerHTML = [
        `<div>Mode: <span style="color:#4ecdc4">${this.config.layoutMode}</span> | Dir: <span style="color:#4ecdc4">${this.config.readingDirection}</span> | Lang: <span style="color:#4ecdc4">${this.config.language}</span></div>`,
        `<div>Images: <span style="color:#fff">${totalImages}</span> total, <span style="color:#fff">${narratableImages}</span> narratable, <span style="color:#4ecdc4">${this._narratedCount}</span> narrated</div>`,
        `<div>Panels: <span style="color:#fff">${this.panels.length}</span> | Scroll: <span style="color:#4ecdc4">${this._scrollProgress}%</span></div>`,
        `<div>Playing: <span style="color:${this.isPlaying ? '#4ecdc4' : '#e94560'}">${this.isPlaying}</span> | Paused: <span style="color:${this.isPaused ? '#ffd93d' : '#888'}">${this.isPaused}</span> | TTS: <span style="color:${this._ttsFailed ? '#e94560' : '#4ecdc4'}">${this._ttsFailed ? 'FAILED' : 'OK'}</span></div>`,
      ].join('');
    }

    // -- MOOD --
    const moodColors = {
      calm: '#4ecdc4', dark: '#6c5ce7', action: '#e94560', bright: '#ffd93d',
      dramatic: '#ff6348', fire: '#ff4500', lightning: '#00d4ff', impact: '#ff1744',
    };
    const lastMood = this._debugLog.length > 0 ? this._debugLog[this._debugLog.length - 1].mood : 'none';
    if (this._debugMoodDisplay) {
      this._debugMoodDisplay.innerHTML = `<div style="font-size:18px;text-align:center;padding:2px;color:${moodColors[lastMood] || '#888'}">${this._getMoodEmoji(lastMood)} ${lastMood.toUpperCase()}</div>`;
    }

    // -- CHARACTER REGISTRY --
    if (this._debugCharSection && this._characterRegistry) {
      const chars = this._characterRegistry._characters || [];
      if (chars.length === 0) {
        this._debugCharSection.innerHTML = '<div style="color:#666">No characters tracked yet</div>';
      } else {
        this._debugCharSection.innerHTML = chars.map((c, i) => {
          const hue = c.dominantHue != null ? c.dominantHue : '?';
          const voiceLabel = c.voiceIdx === 0 ? 'Voice A' : 'Voice B';
          return `<div style="margin-bottom:3px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:hsl(${hue},70%,50%);vertical-align:middle;"></span> Char ${i + 1}: <span style="color:#4ecdc4">${voiceLabel}</span> (seen ${c.seenCount}x, hue ${hue})</div>`;
        }).join('');
      }
    }
  }

  _debugAddEntry(type, text, mood, extra) {
    if (!window.__mangaReaderDebug) return;
    const entry = {
      type,
      text: text.substring(0, 300),
      mood: mood || 'none',
      timestamp: new Date().toLocaleTimeString(),
      extra: extra || null,
    };
    this._debugLog.push(entry);
    if (this._debugLog.length > 200) this._debugLog.shift();

    const moodColors = {
      calm: '#4ecdc4', dark: '#6c5ce7', action: '#e94560', bright: '#ffd93d',
      dramatic: '#ff6348', fire: '#ff4500', lightning: '#00d4ff', impact: '#ff1744',
    };

    // Route to correct section
    const typeColorMap = {
      'ocr': '#4ecdc4', 'ocr-raw': '#88b4b4', 'mood': '#ffd93d', 'effect': '#e94560',
      'sound': '#ff9f43', 'sfx': '#ff6348', 'gutter': '#a29bfe', 'bubble': '#6c5ce7',
      'character': '#fd79a8',
    };
    const borderColor = typeColorMap[type] || '#666';

    // Build the entry div
    const div = document.createElement('div');
    div.style.cssText = `margin-bottom:4px;padding:3px 5px;border-left:3px solid ${borderColor};background:rgba(255,255,255,0.03);font-size:10px;`;
    div.innerHTML = [
      `<div style="color:#666;font-size:9px;">${entry.timestamp} [${type.toUpperCase()}]`,
      mood ? ` <span style="color:${moodColors[mood] || '#888'}">${this._getMoodEmoji(mood)} ${mood}</span>` : '',
      `</div>`,
      `<div style="color:#ddd;word-break:break-word;">${this._escapeHtml(entry.text)}</div>`,
      extra ? `<div style="color:#888;font-size:9px;">${this._escapeHtml(String(extra))}</div>` : '',
    ].join('');

    // Add to specific sections
    if (type === 'ocr' || type === 'ocr-raw') {
      if (this._debugOcrBank) {
        const ocrDiv = div.cloneNode(true);
        this._debugOcrBank.appendChild(ocrDiv);
        this._debugOcrBank.scrollTop = this._debugOcrBank.scrollHeight;
      }
    }
    if (type === 'bubble') {
      if (this._debugBubbleMap) {
        const bDiv = div.cloneNode(true);
        this._debugBubbleMap.appendChild(bDiv);
        this._debugBubbleMap.scrollTop = this._debugBubbleMap.scrollHeight;
      }
    }
    if (type === 'sound' || type === 'sfx') {
      if (this._debugSoundLog) {
        const sDiv = div.cloneNode(true);
        this._debugSoundLog.appendChild(sDiv);
        this._debugSoundLog.scrollTop = this._debugSoundLog.scrollHeight;
      }
    }
    if (type === 'gutter') {
      if (this._debugGutterLog) {
        const gDiv = div.cloneNode(true);
        this._debugGutterLog.appendChild(gDiv);
        this._debugGutterLog.scrollTop = this._debugGutterLog.scrollHeight;
      }
    }

    // Always add to main narration log
    if (this._debugLogContainer) {
      this._debugLogContainer.appendChild(div);
      this._debugLogContainer.scrollTop = this._debugLogContainer.scrollHeight;
    }
    this._updateDebugPanel();
  }

  _debugCopyAll() {
    const data = {
      session: new Date().toISOString(),
      config: { ...this.config },
      stats: {
        totalImages: document.querySelectorAll('img').length,
        narratedCount: this._narratedCount,
        panelCount: this.panels.length,
        scrollProgress: this._scrollProgress,
      },
      characters: this._characterRegistry ? this._characterRegistry._characters.map((c, i) => ({
        id: i, voiceIdx: c.voiceIdx, seenCount: c.seenCount, dominantHue: c.dominantHue,
      })) : [],
      log: this._debugLog,
    };
    const json = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      MangaEngine._dbg('Debug data copied to clipboard');
      const toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;top:50%;right:180px;background:#4ecdc4;color:#000;padding:8px 16px;border-radius:4px;z-index:100001;font-weight:bold;';
      toast.textContent = 'Copied!';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 1500);
    }).catch(() => {});
  }

  _getMoodEmoji(mood) {
    const map = {
      calm: '\u2728', dark: '\ud83c\udf11', action: '\ud83d\udca5', bright: '\u2600',
      dramatic: '\ud83c\udfad', fire: '\ud83d\udd25', lightning: '\u26a1', impact: '\ud83d\udca2',
      none: '\u2014',
    };
    return map[mood] || '\ud83c\udfac';
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  _removeDebugPanel() {
    if (this._debugPanel) {
      this._debugPanel.remove();
      this._debugPanel = null;
      this._debugStats = null;
      this._debugMoodDisplay = null;
      this._debugOcrBank = null;
      this._debugBubbleMap = null;
      this._debugSoundLog = null;
      this._debugCharSection = null;
      this._debugGutterLog = null;
      this._debugLogContainer = null;
    }
  }

  // ============================================================
  //  GUTTER SCANNING — detect text between panels
  // ============================================================

  /**
   * Scan the gutter (space between two panels) for speech bubbles.
   * Uses captureVisibleTab screenshot + DOM text overlay scan.
   */
  async _scanGutter(panelA, panelB, knownTexts) {
    const gutterTexts = [];

    // Prong 1: DOM text overlays in gutter region
    const domText = this._scanDOMTextInGutter(panelA, panelB);
    if (domText) gutterTexts.push(domText);

    // Prong 2: Screenshot-based OCR of the gutter
    if (this._tabCaptureFn) {
      const screenshotText = await this._scanGutterViaCapture(panelA, panelB);
      if (screenshotText) gutterTexts.push(screenshotText);
    }

    // Deduplicate against known panel texts
    const newTexts = gutterTexts.filter(t => {
      const lower = t.toLowerCase().trim();
      if (lower.length < 3) return false;
      for (const known of knownTexts) {
        const k = known.toLowerCase();
        if (k.includes(lower) || lower.includes(k)) return false;
        const wordsA = new Set(k.split(/\s+/));
        const wordsB = new Set(lower.split(/\s+/));
        const overlap = [...wordsB].filter(w => wordsA.has(w)).length;
        if (overlap / Math.max(wordsB.size, 1) > 0.6) return false;
      }
      return true;
    });

    return newTexts.join(' ').trim();
  }

  /**
   * Scan DOM for text overlays positioned in the gutter between two panels.
   * Many manga sites render bubble text as positioned <div> elements.
   */
  _scanDOMTextInGutter(panelA, panelB) {
    try {
      const boxA = panelA.element.getBoundingClientRect();
      const boxB = panelB.element.getBoundingClientRect();

      // Compute gutter bounding rectangle
      const gutterTop = Math.min(boxA.bottom, boxB.bottom) - 20;
      const gutterBottom = Math.max(boxA.top, boxB.top) + 20;
      const gutterLeft = Math.min(boxA.left, boxB.left) - 50;
      const gutterRight = Math.max(boxA.right, boxB.right) + 50;

      if (gutterBottom - gutterTop < 5) return '';

      const textFragments = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (['IMG', 'SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER'].includes(node.tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            // Check if node is in the debug panel
            if (node.closest('#manga-reader-debug') || node.closest('#manga-reader-overlay')) {
              return NodeFilter.FILTER_REJECT;
            }
            const rect = node.getBoundingClientRect();
            const inGutter = rect.top < gutterBottom && rect.bottom > gutterTop &&
                             rect.left < gutterRight && rect.right > gutterLeft;
            if (!inGutter) return NodeFilter.FILTER_SKIP;

            const text = (node.innerText || '').trim();
            if (text.length > 2 && text.length < 500 && node.children.length === 0) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        const text = (node.innerText || '').trim();
        if (text) textFragments.push(text);
      }

      return textFragments.join(' ').trim();
    } catch {
      return '';
    }
  }

  /**
   * Capture a screenshot of the visible tab, crop the gutter region, and OCR it.
   */
  async _scanGutterViaCapture(panelA, panelB) {
    try {
      const boxA = panelA.element.getBoundingClientRect();
      const boxB = panelB.element.getBoundingClientRect();

      const margin = 60;
      const dpr = window.devicePixelRatio || 1;

      // Determine gutter orientation and compute crop region
      const verticalGap = Math.abs(boxB.top - boxA.bottom);
      const horizontalGap = Math.abs(boxB.left - boxA.right);

      let cropRegion;
      if (verticalGap >= horizontalGap && verticalGap > 10) {
        // Vertically stacked panels
        cropRegion = {
          x: Math.max(0, Math.min(boxA.left, boxB.left) - margin),
          y: Math.max(0, boxA.bottom - margin),
          w: Math.max(boxA.right, boxB.right) - Math.min(boxA.left, boxB.left) + margin * 2,
          h: boxB.top - boxA.bottom + margin * 2,
        };
      } else if (horizontalGap > 10) {
        // Side-by-side panels
        cropRegion = {
          x: Math.max(0, boxA.right - margin),
          y: Math.max(0, Math.min(boxA.top, boxB.top) - margin),
          w: boxB.left - boxA.right + margin * 2,
          h: Math.max(boxA.bottom, boxB.bottom) - Math.min(boxA.top, boxB.top) + margin * 2,
        };
      } else {
        return ''; // Panels overlap or are too close
      }

      if (cropRegion.w < 30 || cropRegion.h < 30) return '';

      // Capture the visible tab
      const screenDataUrl = await this._tabCaptureFn();
      if (!screenDataUrl) return '';

      // Scale to device pixels
      const scaledRegion = {
        x: Math.round(cropRegion.x * dpr),
        y: Math.round(cropRegion.y * dpr),
        w: Math.round(cropRegion.w * dpr),
        h: Math.round(cropRegion.h * dpr),
      };

      // Crop the screenshot to the gutter region using canvas
      const cropUrl = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = scaledRegion.w;
          c.height = scaledRegion.h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, scaledRegion.x, scaledRegion.y, scaledRegion.w, scaledRegion.h, 0, 0, scaledRegion.w, scaledRegion.h);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => resolve(null);
        img.src = screenDataUrl;
      });
      if (!cropUrl) return '';

      // Create a temporary image element for OCR (extractText expects an element)
      const tmpImg = new Image();
      tmpImg.src = cropUrl;
      await new Promise((r) => { tmpImg.onload = r; tmpImg.onerror = r; });
      const text = await this.ocr.extractText(tmpImg);
      return text || '';
    } catch (err) {
      MangaEngine._dbg('Gutter capture failed:', err.message);
      return '';
    }
  }

  /**
   * Force lazy-load images just ahead of current scroll position.
   */
  _forceLazyLoadAhead() {
    const lookAhead = window.scrollY + window.innerHeight * 3;
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image'];
    document.querySelectorAll('img').forEach(img => {
      const rect = img.getBoundingClientRect();
      const imgTop = rect.top + window.scrollY;
      if (imgTop > window.scrollY && imgTop < lookAhead) {
        if (img.loading === 'lazy') img.loading = 'eager';
        if (!img.src || img.src === 'about:blank' || img.src.includes('loading.gif')) {
          for (const attr of lazyAttrs) {
            const val = img.getAttribute(attr);
            if (val && (val.startsWith('http') || val.startsWith('/'))) {
              img.src = val;
              break;
            }
          }
        }
      }
    });
  }

  /**
   * Check if an image is worth narrating. Delegates to PanelDetector filters.
   */
  _isNarratableImage(img) {
    if (this.panelDetector) {
      return this.config.layoutMode === 'webtoon'
        ? this.panelDetector._isWebtoonStrip(img)
        : this.panelDetector._isMangaPanel(img);
    }
    const w = img.naturalWidth || img.clientWidth || 0;
    const h = img.naturalHeight || img.clientHeight || 0;
    return w >= 200 && h >= 50;
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
    this._removeFloatingControls();
    this._cleanupActiveEffects();
    this._removeTapZones();
    this._unbindKeyboard();
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

  setVoiceB(index) {
    this._voiceBIndex = index;
    if (this.voiceAssigner) {
      this.voiceAssigner.config.strategy = index >= 0 ? 'character' : 'single';
    }
  }

  getStatus() {
    const lastMood = this._debugLog.length > 0 ? this._debugLog[this._debugLog.length - 1].mood : 'none';
    return {
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentPanel: this.currentPanel,
      totalPanels: this.panels.length,
      currentText: this.currentText,
      scrollProgress: this._scrollProgress || 0,
      isContinuousMode: this.config.layoutMode === 'webtoon',
      currentMood: lastMood,
      narratedCount: this._narratedCount || 0,
    };
  }

  // ============================================================
  //  SMOOTH SCROLLING
  // ============================================================

  /**
   * Smoothly scroll to a panel in the viewport over a given duration.
   * For webtoon/tall images: scrolls to the top of the image.
   * For paged: scrolls to center the image in the viewport.
   * Falls back to scrollIntoView if custom scroll fails.
   */
  async _smoothScrollTo(element, duration) {
    const rect = element.getBoundingClientRect();
    const isWebtoon = this.config.layoutMode === 'webtoon';

    // For tall webtoon strips, scroll to the top with some padding
    // For paged manga panels, center in viewport
    let targetY;
    if (isWebtoon || rect.height > window.innerHeight * 0.8) {
      // Scroll so the top of the image is near the top of the viewport (with 60px padding)
      targetY = window.scrollY + rect.top - 60;
    } else {
      targetY = window.scrollY + rect.top - (window.innerHeight / 2) + (rect.height / 2);
    }

    const startY = window.scrollY;
    const distance = targetY - startY;

    if (Math.abs(distance) < 10) return; // Already there

    // Try scrollable container detection for SPA sites
    const scroller = this._findScrollContainer(element) || null;

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

        const scrollY = startY + distance * eased;
        if (scroller) {
          scroller.scrollTop = scrollY;
        } else {
          window.scrollTo(0, scrollY);
        }

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          // Final safety: make sure the element is actually visible
          const finalRect = element.getBoundingClientRect();
          if (finalRect.top < -100 || finalRect.top > window.innerHeight) {
            element.scrollIntoView({ behavior: 'instant', block: isWebtoon ? 'start' : 'center' });
          }
          resolve();
        }
      };

      requestAnimationFrame(step);
    });
  }

  /**
   * Find the nearest scrollable ancestor (for SPA sites with overflow containers).
   */
  _findScrollContainer(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = window.getComputedStyle(parent);
      const overflow = style.overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
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
      fire: 'Flames engulf the scene!',
      lightning: 'Thunder crackles through the air!',
      impact: 'A powerful strike lands!',
    };

    return `${beat} ${moodText[mood] || 'The story progresses.'}`;
  }

  /**
   * Enhanced image analysis to detect manga-specific scene moods.
   * Samples pixels and returns a mood: calm, dark, bright, action, dramatic, fire, lightning, impact.
   */
  _detectMood(imgElement) {
    try {
      const canvas = document.createElement('canvas');
      const size = 64; // Larger sample for better analysis
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgElement, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      let totalR = 0, totalG = 0, totalB = 0;
      let darkPixels = 0, brightPixels = 0;
      let redHot = 0, orangeWarm = 0, blueElectric = 0, whiteFlash = 0;
      let highContrast = 0;
      const pixelCount = size * size;

      let prevLum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        totalR += r; totalG += g; totalB += b;

        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < 60) darkPixels++;
        if (lum > 200) brightPixels++;

        // Fire: high red, medium green, low blue
        if (r > 180 && g < 120 && b < 80) redHot++;
        if (r > 200 && g > 100 && g < 180 && b < 80) orangeWarm++;

        // Lightning/electric: high blue/cyan
        if (b > 180 && r < 100 && g > 150) blueElectric++;
        // Also white-blue flashes
        if (r > 200 && g > 200 && b > 230) whiteFlash++;

        // Sharp luminosity jumps → impact/action lines
        if (i > 0 && Math.abs(lum - prevLum) > 100) highContrast++;
        prevLum = lum;
      }

      const avgR = totalR / pixelCount;
      const avgG = totalG / pixelCount;
      const avgB = totalB / pixelCount;
      const darkRatio = darkPixels / pixelCount;
      const brightRatio = brightPixels / pixelCount;
      const fireRatio = (redHot + orangeWarm) / pixelCount;
      const electricRatio = (blueElectric + whiteFlash) / pixelCount;
      const contrastRatio = highContrast / pixelCount;

      // Fire scene: lots of red/orange pixels
      if (fireRatio > 0.08) return 'fire';

      // Lightning: blue-white electric pixels
      if (electricRatio > 0.06) return 'lightning';

      // Impact: extreme contrast transitions (speed lines, punches)
      if (contrastRatio > 0.3 && darkRatio > 0.3) return 'impact';

      // Action: high contrast dark+bright mix
      if (darkRatio > 0.4 && brightRatio > 0.1) return 'action';

      // Dark/intense
      if (darkRatio > 0.5) return 'dark';

      // Bright/cheerful
      if (brightRatio > 0.5) return 'bright';

      // Dramatic: warm-toned dark scenes
      if (avgR > avgB + 30 && avgR / Math.max(avgB, 1) > 1.5) return 'dramatic';

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

    // Skip zoom for very tall webtoon strips — zooming a 7000px image looks wrong
    const h = element.naturalHeight || element.clientHeight || 0;
    const w = element.naturalWidth || element.clientWidth || 0;
    if (h > 0 && w > 0 && h / w > 3) return;

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
    if (!this.isPlaying) return;

    // Continuous mode: tap to scroll forward/back by half a viewport
    if (this.config.layoutMode === 'webtoon') {
      const delta = window.innerHeight * 0.5;
      if (side === 'right') window.scrollBy(0, delta);
      else window.scrollBy(0, -delta);
      return;
    }

    if (this.panels.length === 0) return;

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
  //  KEYBOARD NAVIGATION
  // ============================================================

  _bindKeyboard() {
    if (this._keyHandler) return;
    this._keyHandler = (e) => {
      if (!this.isPlaying) return;

      // Continuous mode: only capture Space (pause) and Escape (stop)
      // Do NOT intercept arrow keys — user needs free scrolling
      if (this.config.layoutMode === 'webtoon') {
        switch (e.key) {
          case ' ':
            e.preventDefault();
            this.isPaused ? this.resume() : this.pause();
            break;
          case 'Escape':
            e.preventDefault();
            this.stop();
            break;
        }
        return;
      }

      // Paged mode: arrows navigate panels
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          this._handleTapZone(this.config.readingDirection === 'rtl' ? 'left' : 'right');
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this._handleTapZone(this.config.readingDirection === 'rtl' ? 'right' : 'left');
          break;
        case ' ':
          e.preventDefault();
          this.isPaused ? this.resume() : this.pause();
          break;
        case 'Escape':
          e.preventDefault();
          this.stop();
          break;
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  _unbindKeyboard() {
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  }

  // ============================================================
  //  AMBIENT MOOD HELPER
  // ============================================================

  _setAmbientMood(mood) {
    if (this._ambientProxy) this._ambientProxy.setMood(mood);
    this._debugAddEntry('sound', `Ambient mood: ${mood}`, mood);
  }

  /**
   * Trigger a short SFX burst via the offscreen audio context.
   * Maps manga moods → specific sound types.
   */
  _triggerSFX(mood) {
    // Send sfx action to offscreen document via bridge → background
    const sfxMap = {
      fire: 'sfx_fire',
      lightning: 'sfx_lightning',
      impact: 'sfx_impact',
      action: 'sfx_swoosh',
    };
    const sfxType = sfxMap[mood];
    if (sfxType) {
      this._debugAddEntry('sfx', `SFX triggered: ${sfxType}`, mood);
      // Route through ambient proxy channel
      window.postMessage({
        source: 'manga-reader',
        action: 'ambientSFX',
        sfxType,
      }, '*');
    }
  }

  async destroy() {
    this.stop();
    this._removeOverlay();
    this._removeFloatingControls();
    this._removeDebugPanel();
    this._cleanupActiveEffects();
    this._removeTapZones();
    if (this._ambientProxy) this._ambientProxy.stop();
    if (this._characterRegistry) this._characterRegistry.reset();
    if (this.panelDetector) this.panelDetector.destroy();
    if (this.ocr) await this.ocr.destroy();
    if (window.__mangaReaderOcrDebugHook) delete window.__mangaReaderOcrDebugHook;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

if (typeof window !== 'undefined') {
  window.MangaEngine = MangaEngine;
}
