// src/engine/ocr.js — Text extraction from manga speech bubbles
// Uses external API backend for accurate Manga OCR and Bubble Panel detection

/**
 * OCREngine — extracts text from manga panel images using a backend.
 */
class OCREngine {
  static _dbg(...args) { if (typeof window !== 'undefined' && window.__mangaReaderDebug) console.log('[MangaReader OCR]', ...args); }

  constructor(config = {}) {
    let lang = config.language ?? 'en';
    this.config = { language: lang, apiUrl: config.apiUrl || 'http://127.0.0.1:8000/extract-text' };
    this.fetchImageFn = null;
    this._backendAlive = false;
  }

  setImageFetcher(fn) { this.fetchImageFn = fn; }

  setEnhancedOCRFn(fn) {
    // Legacy — ignored since we use Python backend now.
  }

  setLanguage(lang) {
    this.config.language = lang;
  }

  /** Check if the manga-ocr backend is reachable. */
  async checkBackend() {
    try {
      const baseUrl = this.config.apiUrl.replace(/\/extract-text$/, '');
      const res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(3000) });
      this._backendAlive = res.ok;
    } catch {
      this._backendAlive = false;
    }
    return this._backendAlive;
  }

  async initialize() {
    await this.checkBackend();
    if (this._backendAlive) {
      console.log(`[MangaReader OCR] Backend connected at ${this.config.apiUrl}`);
    } else {
      console.warn('[MangaReader OCR] Backend NOT reachable — OCR will be unavailable. Start the server: cd backend && python main.py');
    }
  }

  async destroy() {
    // No worker to destroy
  }

  async _resolveToDataUrl(imageSource) {
    if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
      return imageSource;
    }

    if (typeof imageSource === 'string' && imageSource.startsWith('http')) {
      if (this.fetchImageFn) {
        return await this.fetchImageFn(imageSource);
      } else {
        try {
          const res = await fetch(imageSource);
          const blob = await res.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          console.warn("[MangaReader OCR] Error fetching image URL directly:", e);
          return null;
        }
      }
    }
    
    if (imageSource instanceof HTMLImageElement) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = imageSource.naturalWidth;
        canvas.height = imageSource.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageSource, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.8);
      } catch (err) {
        if (this.fetchImageFn) {
           return await this.fetchImageFn(imageSource.src);
        }
      }
    }
    return null;
  }

  /**
   * Extract text from a panel image or URL via the backend.
   */
  async extractText(imageSource) {
    try {
      if (imageSource instanceof HTMLImageElement && (!imageSource.complete || imageSource.naturalWidth === 0)) {
        return '';
      }

      // Lazy re-check: if backend was down at init, try again once per call
      if (!this._backendAlive) {
        await this.checkBackend();
        if (!this._backendAlive) {
          OCREngine._dbg('Backend still unreachable — skipping OCR');
          return '';
        }
      }

      let dataUrl = await this._resolveToDataUrl(imageSource);
      if (!dataUrl) return '';

      OCREngine._dbg(`Sending image to backend (${dataUrl.length} bytes)`);

      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_data_url: dataUrl }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Backend OCR failed: ${response.statusText}`);
      }

      const result = await response.json();
      OCREngine._dbg(`Backend returned text: "${result.text}"`);
      return result.text || '';
    } catch (err) {
      console.warn('[MangaReader OCR] extractText error:', err.message);
      if (err.name === 'TimeoutError' || err.message.includes('Failed to fetch')) {
        this._backendAlive = false;
      }
      return '';
    }
  }

  /**
   * Extract text from a panel image, returning per-bubble structured data.
   * @param {HTMLImageElement|string} imageSource
   * @returns {Promise<Array<{text: string, region: {x,y,w,h}}>>}
   */
  async extractBubbles(imageSource) {
    // A more advanced backend would return regions. 
    // Mapped here as a single full-panel response for now until backend supports returning bounding boxes.
    const text = await this.extractText(imageSource);
    if (text) {
        return [{ text: text, region: { x: 0, y: 0, w: 0, h: 0 } }];
    }
    return [];
  }
}

// Export for ES6 or attach to window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OCREngine };
} else if (typeof window !== 'undefined') {
  window.OCREngine = OCREngine;
}
