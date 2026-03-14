// src/engine/manga-engine.js — Core orchestration logic
// Coordinates panel detection, OCR, TTS, and voice assignment into a single playback experience.
// NO Chrome APIs — pure JS for mobile reuse.

/**
 * MangaEngine — main orchestrator for the cinematic manga reading experience.
 */
class MangaEngine {
  /**
   * @param {Object} config
   * @param {number} config.voiceIndex - Default narrator voice index
   * @param {number} config.scrollDelay - ms to wait after scrolling before reading
   * @param {number} config.panelDelay - ms to wait between panels
   * @param {boolean} config.zoomEnabled - Whether to zoom into each panel
   * @param {boolean} config.autoDetectVoices - Whether to use voice assigner
   * @param {string} config.readingDirection - 'ltr' or 'rtl'
   */
  constructor(config = {}) {
    this.config = {
      voiceIndex: config.voiceIndex ?? 0,
      scrollDelay: config.scrollDelay ?? 800,
      panelDelay: config.panelDelay ?? 500,
      zoomEnabled: config.zoomEnabled ?? true,
      autoDetectVoices: config.autoDetectVoices ?? true,
      readingDirection: config.readingDirection ?? 'ltr',
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
  }

  /**
   * Initialize all sub-engines. Must be called before play().
   */
  async initialize() {
    try {
      // Initialize TTS
      this.tts = new window.TTSEngine({
        rate: this.config.voiceIndex !== undefined ? 1.0 : 1.0,
      });
      this.voices = await this.tts.getVoices();
      console.log(`[MangaReader] TTS ready — ${this.voices.length} voices available`);

      // Initialize OCR (config paths are set by content.js)
      this.ocr = new window.OCREngine(this._ocrConfig || {});
      await this.ocr.initialize();

      // Initialize Panel Detector
      this.panelDetector = new window.PanelDetector({
        readingDirection: this.config.readingDirection,
      });

      // Initialize Voice Assigner (Phase 1: single voice)
      this.voiceAssigner = new window.VoiceAssigner({ strategy: 'single' });

      // Detect panels
      this.panels = await this.panelDetector.detect();

      this.emitStatus();
      console.log(`[MangaReader] Engine initialized — ${this.panels.length} panels detected`);
    } catch (err) {
      console.error('[MangaReader] Engine initialization error:', err);
    }
  }

  /**
   * Set OCR configuration (called by content.js before initialize).
   * @param {Object} ocrConfig
   */
  setOCRConfig(ocrConfig) {
    this._ocrConfig = ocrConfig;
  }

  /**
   * Set the image fetcher function on the OCR engine.
   * @param {Function} fn - async function(url) => dataUrl
   */
  setImageFetcher(fn) {
    if (this.ocr) {
      this.ocr.setImageFetcher(fn);
    }
    this._imageFetcher = fn;
  }

  /**
   * Start or resume playback from the current panel.
   */
  async play() {
    this.isPlaying = true;
    this.isPaused = false;

    // Re-detect panels to catch any lazy-loaded images
    this.panels = await this.panelDetector.detect();
    this.emitStatus();

    for (let i = this.currentPanel; i < this.panels.length; i++) {
      if (!this.isPlaying) break;
      while (this.isPaused) {
        await this._sleep(100);
      }
      if (!this.isPlaying) break;

      this.currentPanel = i;
      const panel = this.panels[i];

      // Cache original styles before any modification
      this.cacheOriginalStyle(panel.element);

      await this.scrollToPanel(panel.element);
      await this._sleep(this.config.scrollDelay);
      await this.zoomToPanel(panel.element);

      const text = await this.ocr.extractText(panel.element);
      this.currentText = text;
      this.emitStatus();

      if (text.trim()) {
        try {
          const voiceCount = this.voices.length || 1;
          const voiceIdx = this.voiceAssigner.assignVoice(panel.element, voiceCount);
          await this.tts.speak(text, voiceIdx);
        } catch (err) {
          console.warn('[MangaReader] TTS error on panel', i, err);
        }
      }

      // Restore panel to original style after reading
      this.restoreOriginalStyle(panel.element);
      await this._sleep(this.config.panelDelay);
      this.emitStatus();
    }

    this.isPlaying = false;
    this.emitStatus();
  }

  /** Pause playback and TTS */
  pause() {
    this.isPaused = true;
    this.tts.pause();
    this.emitStatus();
  }

  /** Resume from paused state */
  resume() {
    this.isPaused = false;
    this.tts.resume();
    this.emitStatus();
  }

  /** Stop everything, restore DOM, reset to panel 0 */
  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this.currentPanel = 0;
    this.currentText = '';
    this.tts.stop();
    this.restoreAllStyles();
    this.emitStatus();
  }

  /**
   * Jump to a specific panel index.
   * @param {number} index
   */
  jumpToPanel(index) {
    if (index >= 0 && index < this.panels.length) {
      this.currentPanel = index;
      this.emitStatus();
    }
  }

  /**
   * Update TTS speech rate.
   * @param {number} rate
   */
  setSpeed(rate) {
    this.tts.setRate(rate);
  }

  /**
   * Get current engine status.
   * @returns {{isPlaying: boolean, isPaused: boolean, currentPanel: number, totalPanels: number, currentText: string}}
   */
  getStatus() {
    return {
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentPanel: this.currentPanel,
      totalPanels: this.panels.length,
      currentText: this.currentText,
    };
  }

  /**
   * Scroll the viewport to center on a panel element.
   * @param {HTMLElement} element
   */
  async scrollToPanel(element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this._sleep(600); // Allow scroll animation to complete
  }

  /**
   * Zoom into a panel element for cinematic effect.
   * Uses GSAP if available, otherwise CSS transitions.
   * @param {HTMLElement} element
   */
  async zoomToPanel(element) {
    if (!this.config.zoomEnabled) return;

    if (window.gsap) {
      await new Promise((resolve) => {
        window.gsap.to(element, {
          scale: 1.05,
          duration: 0.4,
          ease: 'power2.out',
          onComplete: resolve,
        });
      });
    } else {
      element.style.transition = 'transform 0.4s ease';
      element.style.transform = 'scale(1.05)';
      await this._sleep(400);
    }
  }

  // --- DOM state caching and restoration ---

  /**
   * Store original inline styles before modifying a panel.
   * @param {HTMLElement} element
   */
  cacheOriginalStyle(element) {
    if (!this._originalStyles.has(element)) {
      this._originalStyles.set(element, element.getAttribute('style') || '');
    }
  }

  /**
   * Restore a single panel to its original style.
   * @param {HTMLElement} element
   */
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

  /** Restore ALL modified panels — called by stop() */
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

  /** Emit a status update as a custom DOM event */
  emitStatus() {
    try {
      const event = new CustomEvent('mangareader:status', {
        detail: this.getStatus(),
      });
      document.dispatchEvent(event);
    } catch {
      // Ignore event dispatch errors
    }
  }

  /** Full teardown — stop + free OCR worker memory */
  async destroy() {
    this.stop();
    if (this.panelDetector) this.panelDetector.destroy();
    if (this.ocr) await this.ocr.destroy();
  }

  /** @param {number} ms */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export for both module and script-tag contexts
if (typeof window !== 'undefined') {
  window.MangaEngine = MangaEngine;
}
