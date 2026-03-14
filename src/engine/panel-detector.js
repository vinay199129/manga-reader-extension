// src/engine/panel-detector.js — Finds manga panels on a web page in correct reading order
// Supports paged (LTR/RTL) and webtoon (long scroll) layout modes.
// Phase 2 upgrade: replace heuristic detect() with ONNX.js model inference.

/**
 * PanelDetector — identifies manga panel images on a page using DOM heuristics.
 */
class PanelDetector {
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy ?? 'heuristic',
      minWidth: config.minWidth ?? 150,
      minHeight: config.minHeight ?? 120,
      readingDirection: config.readingDirection ?? 'ltr',
      layoutMode: config.layoutMode ?? 'paged', // 'paged' | 'webtoon'
    };
    this.observer = null;
  }

  /**
   * Detect all manga panels on the current page.
   * Handles lazy-loaded images by pre-scrolling the page first.
   */
  async detect() {
    this._updateOverlay('Scanning page...');
    
    // Scroll to bottom and back to trigger lazy loading
    await this._scrollScan();
    
    // Attempt attribute-based lazy load handling
    this._forceLazyLoad();
    
    // Wait for network/DOM
    await this._sleep(1500);

    const allImages = Array.from(document.querySelectorAll('img'));
    console.log(`[MangaReader PanelDetector] Total <img> elements: ${allImages.length} (mode: ${this.config.layoutMode}, dir: ${this.config.readingDirection})`);

    // Log each image for debugging
    allImages.forEach((img, i) => {
      const w = img.naturalWidth || img.clientWidth || 0;
      const h = img.naturalHeight || img.clientHeight || 0;
      const src = (img.src || img.dataset?.src || '').substring(0, 80);
      console.log(`[MangaReader PanelDetector]   img[${i}] ${w}x${h} src="${src}"`);
    });

    let panels;
    if (this.config.layoutMode === 'webtoon') {
      panels = this._detectWebtoon(allImages);
    } else {
      panels = this._detectPaged(allImages);
    }

    this._observeNewImages();

    console.log(`[MangaReader PanelDetector] Found ${panels.length} panels`);
    panels.forEach((p, i) => {
      const w = p.element.naturalWidth || p.element.clientWidth;
      const h = p.element.naturalHeight || p.element.clientHeight;
      console.log(`[MangaReader PanelDetector]   Panel ${i + 1}: ${w}x${h}`);
    });
    return panels;
  }

  /**
   * Detect panels in paged (standard manga) layout.
   * Sorts by reading direction: LTR = left-to-right, RTL = right-to-left.
   */
  _detectPaged(allImages) {
    const filtered = allImages.filter(img => {
      const pass = this._isMangaPanel(img);
      if (!pass) {
        const w = img.naturalWidth || img.clientWidth || 0;
        const h = img.naturalHeight || img.clientHeight || 0;
        const src = (img.src || '').substring(0, 60);
        console.log(`[MangaReader PanelDetector] SKIPPED: ${w}x${h} src="${src}"`);
      }
      return pass;
    });
    console.log(`[MangaReader PanelDetector] Paged filter: ${filtered.length}/${allImages.length} passed`);
    return filtered
      .sort((a, b) => this._sortByReadingOrder(a, b))
      .map((element, index) => ({
        element,
        boundingBox: element.getBoundingClientRect(),
        index,
      }));
  }

  /**
   * Detect panels in webtoon (long vertical scroll) layout.
   * In webtoon mode: all qualifying images are in strict top-to-bottom order.
   * Adjacent tall images might represent parts of one scene.
   */
  _detectWebtoon(allImages) {
    return allImages
      .filter(img => this._isWebtoonStrip(img))
      .sort((a, b) => {
        const topA = a.getBoundingClientRect().top + window.scrollY;
        const topB = b.getBoundingClientRect().top + window.scrollY;
        return topA - topB;
      })
      .map((element, index) => ({
        element,
        boundingBox: element.getBoundingClientRect(),
        index,
      }));
  }

  /**
   * Check if image qualifies as a webtoon strip panel.
   * Webtoon strips are typically full-width, tall images.
   */
  _isWebtoonStrip(img) {
    const style = window.getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const width = img.naturalWidth || img.clientWidth || img.width || 0;
    const height = img.naturalHeight || img.clientHeight || img.height || 0;
    if (width === 0 && height === 0) return false;

    // Webtoon strips: at least 200px wide (less strict on height)
    if (width < 200) return false;

    const src = (img.src || '').toLowerCase();
    if (!src || src === 'about:blank') return false;

    // Skip ad/UI images
    if (this._isUIImage(src)) return false;

    return true;
  }

  /**
   * Check if an image qualifies as a paged manga panel.
   */
  _isMangaPanel(img) {
    const style = window.getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const width = img.naturalWidth || img.clientWidth || img.width || parseInt(img.getAttribute('width')) || 0;
    const height = img.naturalHeight || img.clientHeight || img.height || parseInt(img.getAttribute('height')) || 0;

    if (width === 0 && height === 0) return false;
    if (width < this.config.minWidth && height < this.config.minHeight) return false;

    const src = (img.src || '').toLowerCase();
    if (!src || src === 'about:blank' || src.endsWith('pixel.gif') || src.endsWith('blank.gif')) return false;

    if (this._isUIImage(src)) return false;

    // Skip very extreme aspect ratios (banners/separators)
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio > 8 || ratio < 0.05) return false;
    }

    return true;
  }

  /**
   * Check if src matches known UI/ad image patterns.
   */
  _isUIImage(src) {
    const skipExact = ['/icon', '/logo', '/avatar', '/banner', '/button', '/nav/', 'favicon', 'sprite', 'emoji', 'sticker'];
    if (skipExact.some(pattern => src.includes(pattern))) return true;

    const adDomains = ['googlesyndication', 'doubleclick', 'adservice', 'adsense', 'adnxs'];
    if (adDomains.some(d => src.includes(d))) return true;

    const filename = src.split('/').pop() || '';
    if (filename.includes('thumb') && !filename.includes('_')) return true;

    return false;
  }

  /**
   * Scroll down the page to trigger lazy loaded images.
   */
  async _scrollScan() {
    console.log('[MangaReader] Scanning page for lazy images...');
    const originalY = window.scrollY;
    const height = document.body.scrollHeight;
    
    // Quick scan down in steps
    for (let scrollY = 0; scrollY < height; scrollY += 800) {
      window.scrollTo(0, scrollY);
      await new Promise(r => setTimeout(r, 60)); 
    }
    
    // Ensure bottom is reached
    window.scrollTo(0, height);
    await new Promise(r => setTimeout(r, 200));

    // Scroll back to top
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 200));
    
    // Restore original position if user had scrolled
    if (originalY > 0) window.scrollTo(0, originalY);
  }

  _updateOverlay(msg) {
    // Optional: communicate status via custom event
    document.dispatchEvent(new CustomEvent('mangareader:detectStatus', { detail: msg }));
  }

  /**
   * Sort two images by reading order.
   * LTR: top-to-bottom, then left-to-right
   * RTL: top-to-bottom, then right-to-left
   */
  _sortByReadingOrder(a, b) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();

    const topA = rectA.top + window.scrollY;
    const topB = rectB.top + window.scrollY;

    const verticalDiff = topA - topB;
    if (Math.abs(verticalDiff) > 50) return verticalDiff;

    if (this.config.readingDirection === 'rtl') {
      return rectB.left - rectA.left;
    }
    return rectA.left - rectB.left;
  }

  /**
   * Force lazy-loaded images to load.
   */
  _forceLazyLoad() {
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image'];
    document.querySelectorAll('img').forEach(img => {
      if (!img.src || img.src === 'about:blank' || img.src.endsWith('loading.gif') || img.src.includes('pixel.gif')) {
        for (const attr of lazyAttrs) {
          const val = img.getAttribute(attr);
          if (val && val.startsWith('http')) {
            img.src = val;
            break;
          }
        }
      }
    });
  }

  /**
   * Pre-scroll the page to trigger lazy-loaded images.
   */
  async _waitForImages() {
    try {
      const originalScroll = window.scrollY;
      const pageHeight = document.body.scrollHeight;
      const viewportHeight = window.innerHeight;
      const steps = Math.ceil(pageHeight / viewportHeight);

      console.log(`[MangaReader PanelDetector] Pre-scrolling (${steps} steps)...`);

      for (let i = 0; i <= steps; i++) {
        window.scrollTo(0, i * viewportHeight);
        await this._sleep(300);
      }
      window.scrollTo(0, pageHeight);
      await this._sleep(500);
      window.scrollTo(0, originalScroll);
      await this._sleep(500);
    } catch (err) {
      console.warn('[MangaReader PanelDetector] waitForImages error:', err);
    }
  }

  _observeNewImages() {
    if (this.observer) return;
    this.observer = new MutationObserver(() => {});
    this.observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.PanelDetector = PanelDetector;
}
