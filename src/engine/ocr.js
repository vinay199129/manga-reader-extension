// src/engine/ocr.js — Text extraction from manga speech bubbles using Tesseract.js
// Phase 2 upgrade path: replace Tesseract.js with manga-ocr API hosted on Hugging Face Spaces
// (free tier) for significantly better accuracy on Japanese/stylised manga text.

/**
 * OCREngine — extracts text from manga panel images using Tesseract.js.
 * No Chrome APIs — pure JS for mobile reuse.
 */
class OCREngine {
  /**
   * @param {Object} config
   * @param {string} config.language - OCR language (default 'eng')
   * @param {string|null} config.workerPath - Path to Tesseract worker.min.js
   * @param {string|null} config.corePath - Path to Tesseract WASM core
   * @param {string|null} config.langPath - Path to language data directory
   */
  constructor(config = {}) {
    this.config = {
      language: config.language ?? 'eng',
      workerPath: config.workerPath ?? null,
      corePath: config.corePath ?? null,
      langPath: config.langPath ?? null,
    };
    this.worker = null;
    this.fetchImageFn = null;
  }

  /**
   * Set a function for fetching cross-origin images as data URLs.
   * Called by content.js during engine initialization.
   * @param {Function} fn - async function(url) => dataUrl string
   */
  setImageFetcher(fn) {
    this.fetchImageFn = fn;
  }

  /**
   * Initialize the Tesseract worker. Must be called once before extractText().
   */
  async initialize() {
    try {
      if (!window.Tesseract) {
        console.warn('[MangaReader OCR] Tesseract.js not available — OCR disabled');
        return;
      }

      const workerConfig = {};
      if (this.config.workerPath) workerConfig.workerPath = this.config.workerPath;
      if (this.config.corePath) workerConfig.corePath = this.config.corePath;
      if (this.config.langPath) workerConfig.langPath = this.config.langPath;

      this.worker = await window.Tesseract.createWorker(this.config.language, 1, workerConfig);
      console.log('[MangaReader OCR] Tesseract worker initialized');
    } catch (err) {
      console.error('[MangaReader OCR] Failed to initialize:', err);
      this.worker = null;
    }
  }

  /**
   * Extract text from an image element or data URL.
   * @param {HTMLImageElement|string} imageSource - <img> element or data URL string
   * @returns {Promise<string>} Extracted text, or empty string on failure
   */
  async extractText(imageSource) {
    if (!this.worker) return '';
    try {
      const source = await this._resolveImageSource(imageSource);
      if (!source) return '';
      const { data: { text } } = await this.worker.recognize(source);
      return text || '';
    } catch (err) {
      console.warn('[MangaReader OCR] extractText error:', err);
      return '';
    }
  }

  /**
   * Extract text from a specific region of an image.
   * @param {HTMLImageElement|string} imageSource
   * @param {{x: number, y: number, width: number, height: number}} region
   * @returns {Promise<string>}
   */
  async extractTextFromRegion(imageSource, region) {
    if (!this.worker) return '';
    try {
      const source = await this._resolveImageSource(imageSource);
      if (!source) return '';
      const { data: { text } } = await this.worker.recognize(source, {
        rectangle: { top: region.y, left: region.x, width: region.width, height: region.height },
      });
      return text || '';
    } catch (err) {
      console.warn('[MangaReader OCR] extractTextFromRegion error:', err);
      return '';
    }
  }

  /**
   * Resolve an image source to something Tesseract can process.
   * Handles cross-origin images by falling back to the image fetcher.
   * @param {HTMLImageElement|string} imageSource
   * @returns {Promise<string|HTMLImageElement|null>}
   */
  async _resolveImageSource(imageSource) {
    // Data URL string — use directly
    if (typeof imageSource === 'string') {
      return imageSource;
    }
    // <img> element — try direct use first
    if (imageSource instanceof HTMLImageElement) {
      // Test if the image is cross-origin by trying a canvas draw
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageSource, 0, 0, 1, 1);
        ctx.getImageData(0, 0, 1, 1); // Will throw if tainted
        return imageSource; // Same-origin — safe to use directly
      } catch {
        // Cross-origin — use fetcher
        if (this.fetchImageFn && imageSource.src) {
          const dataUrl = await this.fetchImageFn(imageSource.src);
          return dataUrl || null;
        }
        return null;
      }
    }
    return null;
  }

  /** Terminate the Tesseract worker to free memory */
  async destroy() {
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // Ignore termination errors
      }
      this.worker = null;
    }
  }
}

// Export for both module and script-tag contexts
if (typeof window !== 'undefined') {
  window.OCREngine = OCREngine;
}
