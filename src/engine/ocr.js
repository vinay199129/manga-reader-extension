// src/engine/ocr.js — Text extraction from manga speech bubbles
// Two-stage pipeline: detect bubble regions → OCR only those crops.
// Runs Tesseract.js directly in MAIN world content script.
// Uses Blob-based worker creation to bypass cross-origin restrictions.

/**
 * OCREngine — extracts text from manga panel images.
 */
class OCREngine {
  constructor(config = {}) {
    // Normalize language codes: eng→en, jpn→ja, kor→ko
    let lang = config.language ?? 'en';
    if (lang === 'eng') lang = 'en';
    else if (lang === 'jpn') lang = 'ja';
    else if (lang === 'kor') lang = 'ko';
    this.config = { language: lang };
    
    this._worker = null;
    this._workerInitPromise = null;
    this.fetchImageFn = null;
  }

  setImageFetcher(fn) { this.fetchImageFn = fn; }
  
  // No longer needed, but kept for API compatibility
  setOCRProxy(fn) {} 

  setLanguage(lang) {
    if (lang === 'eng') lang = 'en';
    else if (lang === 'jpn') lang = 'ja';
    else if (lang === 'kor') lang = 'ko';
    this.config.language = lang;
  }

  async initialize() {
    console.log(`[MangaReader OCR] Initializing local Tesseract (lang=${this.config.language})...`);
    // Pre-initialize worker to save time later
    try {
      await this._ensureWorker();
    } catch (err) {
      console.warn('[MangaReader OCR] Pre-init failed (will retry on demand):', err);
    }
  }

  async destroy() {
    console.log('[MangaReader OCR] Destroying worker...');
    if (this._worker) {
      try {
        await this._worker.terminate();
      } catch (err) {
        console.warn('[MangaReader OCR] Worker termination error:', err);
      }
      this._worker = null;
    }
    this._workerInitPromise = null;
  }

  /**
   * Extract text from a panel image or URL.
   */
  async extractText(imageSource) {
    try {
      let dataUrl = await this._resolveToDataUrl(imageSource);
      if (!dataUrl) return '';

      // Stage 1: Detect speech bubble regions
      const bubbleRegions = await this._detectBubbleRegions(dataUrl);

      if (bubbleRegions.length === 0) {
        // No bubbles found — try full image as fallback
        console.log('[MangaReader OCR] No bubble regions found — trying full image');
        return await this._ocrSingleRegion(dataUrl);
      }

      console.log(`[MangaReader OCR] Found ${bubbleRegions.length} bubble region(s)`);

      // Stage 2: OCR each bubble locally
      const texts = [];
      for (const region of bubbleRegions) {
        const cropUrl = await this._cropRegion(dataUrl, region);
        if (!cropUrl) continue;
        
        try {
          const text = await this._recognize(cropUrl);
          if (text && text.trim().length > 1) {
             texts.push(text.trim());
          }
        } catch (err) {
          console.warn('[MangaReader OCR] Recognize error:', err);
        }
      }

      return texts.join(' ');
    } catch (err) {
      console.warn('[MangaReader OCR] extractText error:', err.message);
      return '';
    }
  }

  // ============================================================
  //  Local Tesseract Worker Management
  // ============================================================

  async _ensureWorker() {
    if (this._worker) {
      console.log('[MangaReader OCR] Using existing worker');
      return this._worker;
    }
    if (this._workerInitPromise) {
      console.log('[MangaReader OCR] Worker initialization already in progress...');
      return this._workerInitPromise;
    }

    this._workerInitPromise = (async () => {
      try {
        console.log('[MangaReader OCR] Starting worker initialization...');
        
        if (typeof window === 'undefined') {
          throw new Error('Not running in browser context');
        }
        
        console.log('[MangaReader OCR] Checking for Tesseract library...');
        console.log('[MangaReader OCR] window.Tesseract exists:', typeof window.Tesseract !== 'undefined');
        console.log('[MangaReader OCR] window.Tesseract.createWorker exists:', typeof window.Tesseract?.createWorker === 'function');
        
        if (typeof window.Tesseract === 'undefined') {
          throw new Error('Tesseract library not loaded - window.Tesseract is undefined');
        }
        
        if (typeof window.Tesseract.createWorker !== 'function') {
          throw new Error('window.Tesseract.createWorker is not a function');
        }

        const lang = this.config.language === 'ja' ? 'jpn' : 'eng';
        const extUrl = window.__mangaReaderExtURL || '';
        
        if (!extUrl) {
          throw new Error('Extension URL not set - window.__mangaReaderExtURL is empty');
        }
        
        const workerConfig = {
          workerPath: `${extUrl}/lib/tesseract/worker.min.js`,
          corePath: `${extUrl}/lib/tesseract/tesseract-core-simd.wasm.js`,
          langPath: `${extUrl}/lib/tesseract/`,
          logger: m => {
            console.log(`[MangaReader OCR] Status: ${m.status}, Progress: ${Math.round((m.progress || 0) * 100)}%`);
          }
        };
        
        console.log(`[MangaReader OCR] Creating worker for language: ${lang}`);
        console.log('[MangaReader OCR] Worker config:', JSON.stringify(workerConfig, null, 2));
        
        this._worker = await window.Tesseract.createWorker(workerConfig);
        
        console.log('[MangaReader OCR] createWorker returned:', this._worker);
        console.log('[MangaReader OCR] Worker type:', typeof this._worker);
        console.log('[MangaReader OCR] Worker has recognize method:', typeof this._worker?.recognize === 'function');
        
        if (!this._worker) {
          throw new Error('Tesseract.createWorker returned null/undefined');
        }
        
        if (typeof this._worker.recognize !== 'function') {
          console.error('[MangaReader OCR] Worker object:', this._worker);
          throw new Error('Worker does not have a recognize method');
        }
        
        // Initialize worker: load core and language
        console.log('[MangaReader OCR] Loading language data...');
        await this._worker.loadLanguage(lang);
        console.log('[MangaReader OCR] Initializing for language:', lang);
        await this._worker.initialize(lang);
        
        console.log('[MangaReader OCR] ✅ Worker created and initialized successfully!');
        return this._worker;
      } catch (err) {
        console.error('[MangaReader OCR] ❌ Worker creation failed!');
        console.error('[MangaReader OCR] Error name:', err.name);
        console.error('[MangaReader OCR] Error message:', err.message);
        console.error('[MangaReader OCR] Error stack:', err.stack);
        this._workerInitPromise = null; // Reset so we can retry
        this._worker = null;
        throw err;
      }
    })();

    return this._workerInitPromise;
  }

  async _recognize(imageUrl) {
    try {
      const worker = await this._ensureWorker();
      if (!worker) {
        throw new Error('Worker is null after _ensureWorker');
      }
      console.log('[MangaReader OCR] Starting recognition...');
      const result = await worker.recognize(imageUrl);
      const cleanText = this._cleanOCRText(result.data.text, this.config.language);
      console.log(`[MangaReader OCR] Recognized: "${cleanText.substring(0, 100)}"`);
      return cleanText;
    } catch (err) {
      console.error('[MangaReader OCR] Recognition failed:', err);
      throw err;
    }
  }

  async _ocrSingleRegion(dataUrl) {
    if (!this._worker) {
       await this._ensureWorker();
    }
    return this._recognize(dataUrl);
  }

  // ============================================================
  //  STAGE 1: Speech Bubble Detection (canvas-based)
  // ============================================================

  /**
   * Find bright rectangular regions in the image that look like speech bubbles.
   * Uses connected-component analysis on thresholded brightness map.
   * @returns {Array<{x, y, w, h}>} Bounding boxes of bubble candidates
   */
  async _detectBubbleRegions(dataUrl) {
    try {
      const img = await this._loadAsImage(dataUrl);
      if (!img) return [];

      const canvas = document.createElement('canvas');
      const maxDim = 800;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (iw === 0 || ih === 0) return [];

      const scale = Math.min(maxDim / iw, maxDim / ih, 1);
      const w = Math.round(iw * scale);
      const h = Math.round(ih * scale);
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;

      // Create binary map: 1 = bright (bubble candidate), 0 = dark
      const binary = new Uint8Array(w * h);
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        binary[i / 4] = lum > 200 ? 1 : 0;
      }

      // Connected component labeling (simple flood fill)
      const labels = new Int32Array(w * h);
      let nextLabel = 1;
      const regions = [];

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (binary[idx] === 1 && labels[idx] === 0) {
            // Flood fill to find connected bright region
            const region = { minX: x, minY: y, maxX: x, maxY: y, area: 0 };
            const stack = [idx];
            labels[idx] = nextLabel;

            while (stack.length > 0) {
              // Safety cap: stop if region grows too large (avoids tab freeze)
              if (region.area > 100000) break;
              const ci = stack.pop();
              const cx = ci % w;
              const cy = (ci - cx) / w;
              region.area++;
              if (cx < region.minX) region.minX = cx;
              if (cy < region.minY) region.minY = cy;
              if (cx > region.maxX) region.maxX = cx;
              if (cy > region.maxY) region.maxY = cy;

              // 4-connected neighbors
              const neighbors = [];
              if (cx > 0) neighbors.push(ci - 1);
              if (cx < w - 1) neighbors.push(ci + 1);
              if (cy > 0) neighbors.push(ci - w);
              if (cy < h - 1) neighbors.push(ci + w);

              for (const ni of neighbors) {
                if (binary[ni] === 1 && labels[ni] === 0) {
                  labels[ni] = nextLabel;
                  stack.push(ni);
                }
              }
            }
            nextLabel++;
            regions.push(region);
          }
        }
      }

      // Filter regions: must be reasonable bubble size
      const minBubbleArea = (w * h) * 0.005;  // at least 0.5% of image
      const maxBubbleArea = (w * h) * 0.5;    // at most 50% of image
      const minBubbleW = w * 0.05;
      const minBubbleH = h * 0.03;

      const bubbles = regions
        .filter(r => {
          const rw = r.maxX - r.minX;
          const rh = r.maxY - r.minY;
          const area = r.area;
          // Must be big enough to contain text
          if (area < minBubbleArea) return false;
          if (area > maxBubbleArea) return false;
          if (rw < minBubbleW || rh < minBubbleH) return false;
          // Must be somewhat compact (not a huge background region)
          const boundingArea = rw * rh;
          const fillRatio = area / Math.max(boundingArea, 1);
          if (fillRatio < 0.3) return false; // Too sparse — probably background
          return true;
        })
        .map(r => ({
          // Scale back to original image coordinates with padding
          x: Math.max(0, Math.round(r.minX / scale) - 5),
          y: Math.max(0, Math.round(r.minY / scale) - 5),
          w: Math.min(iw, Math.round((r.maxX - r.minX) / scale) + 10),
          h: Math.min(ih, Math.round((r.maxY - r.minY) / scale) + 10),
        }))
        // Sort top-to-bottom, then right-to-left (manga reading order)
        .sort((a, b) => {
          const yDiff = a.y - b.y;
          if (Math.abs(yDiff) > 20) return yDiff;
          return b.x - a.x;
        })
        // Limit to reasonable number of bubbles per panel
        .slice(0, 8);

      return bubbles;
    } catch (err) {
      console.warn('[MangaReader OCR] Bubble detection failed:', err.message);
      return [];
    }
  }

  /**
   * Crop a specific region from a data URL image.
   */
  async _cropRegion(dataUrl, region) {
    try {
      const img = await this._loadAsImage(dataUrl);
      if (!img) return null;

      const canvas = document.createElement('canvas');
      canvas.width = region.w;
      canvas.height = region.h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }



  // ============================================================
  //  Image resolution & preprocessing (Same as before)
  // ============================================================

  async _resolveToDataUrl(imageSource) {
    if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
      return imageSource;
    }
    
    // Convert relative URL to full URL if necessary
    if (typeof imageSource === 'string' && !imageSource.startsWith('http') && window.__mangaReaderExtURL) {
      if (imageSource.startsWith('blob:') || imageSource.includes('tesseract')) {
         // skip internal blobs
      } else {
         try {
           imageSource = new URL(imageSource, document.baseURI).href; 
         } catch (e) {}
      }
    }
    
    // ... rest of previous implementation ...
    
    if (typeof imageSource === 'string') {
      if (this.fetchImageFn) return await this.fetchImageFn(imageSource);
      return null;
    }

    if (imageSource instanceof HTMLImageElement) {
       try {
        const canvas = document.createElement('canvas');
        const w = imageSource.naturalWidth || imageSource.width;
        const h = imageSource.naturalHeight || imageSource.height;
        if (w === 0 || h === 0) return null;
        
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageSource, 0, 0);
        return canvas.toDataURL('image/png');
       } catch (e) {
         if (this.fetchImageFn && imageSource.src) {
           return await this.fetchImageFn(imageSource.src);
         }
       }
    }
    return null;
  }

  /**
   * Preprocess for Tesseract: high-contrast black text on white background.
   */
  async _preprocessForBubbles(dataUrl) {
    try {
      const img = await this._loadAsImage(dataUrl);
      if (!img) return null;

      const canvas = document.createElement('canvas');
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;

      const maxDim = 2000;
      let scale = 1;
      if (w > maxDim || h > maxDim) scale = maxDim / Math.max(w, h);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // Binarize: bright → white, dark → black, middle → white
      for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (gray < 80) {
          data[i] = data[i + 1] = data[i + 2] = 0;   // Text (dark)
        } else {
          data[i] = data[i + 1] = data[i + 2] = 255;  // Background (white)
        }
      }

      ctx.putImageData(imageData, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  _loadAsImage(source) {
    return new Promise((resolve) => {
      if (source instanceof HTMLImageElement) {
        if (source.complete && source.naturalWidth > 0) return resolve(source);
        source.onload = () => resolve(source);
        source.onerror = () => resolve(null);
        return;
      }
      if (typeof source === 'string') {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = source;
        return;
      }
      resolve(null);
    });
  }

  /**
   * Clean OCR output. Language-aware filtering.
   */
  _cleanOCRText(raw, lang) {
    if (!raw) return '';

    let text = raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length >= 2)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // For English: filter lines that are mostly non-alpha garbage
    if (lang === 'en' || lang === 'auto') {
      const words = text.split(/\s+/);
      const validWords = words.filter(w => {
        const alpha = (w.match(/[a-zA-Z]/g) || []).length;
        return alpha / Math.max(w.length, 1) > 0.4;
      });
      if (validWords.length < words.length * 0.3 && words.length > 2) {
        return ''; // Too much garbage — probably not real text
      }
    }
    
    // Remove underscores, bars, and single char noise
    text = text.replace(/[_|]/g, '').replace(/ [a-z] /g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3) return '';

    return text;
  }
}

if (typeof window !== 'undefined') {
  window.OCREngine = OCREngine;
}
