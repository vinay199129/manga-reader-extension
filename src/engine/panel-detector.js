// src/engine/panel-detector.js — Finds manga panels on a web page in correct reading order
// Supports paged (LTR/RTL) and webtoon (long scroll) layout modes.
// Phase 2 upgrade: replace heuristic detect() with ONNX.js model inference.

/**
 * PanelDetector — identifies manga panel images on a page using DOM heuristics.
 */
class PanelDetector {
  static _dbg(...args) { if (typeof window !== 'undefined' && window.__mangaReaderDebug) console.log('[MangaReader PanelDetector]', ...args); }

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

    // Scroll to bottom and back to trigger lazy loading (multiple passes for SPA/React sites)
    await this._scrollScan();

    // Attempt attribute-based lazy load handling
    this._forceLazyLoad();

    // Wait for network/DOM — longer wait for SPA-rendered content
    await this._sleep(2000);

    // Second pass: SPA sites may need a re-scroll after initial images render
    // (React/Next.js IntersectionObserver triggers on scroll, but rendering is async)
    const imgCountBefore = document.querySelectorAll('img').length;
    await this._scrollScan();
    await this._sleep(1000);
    const imgCountAfter = document.querySelectorAll('img').length;
    if (imgCountAfter > imgCountBefore) {
      PanelDetector._dbg(`Second pass found ${imgCountAfter - imgCountBefore} new images, doing a third pass`);
      await this._scrollScan();
      await this._sleep(1000);
    }

    const allImages = Array.from(document.querySelectorAll('img'));
    PanelDetector._dbg(`Total <img> elements: ${allImages.length} (mode: ${this.config.layoutMode}, dir: ${this.config.readingDirection})`);

    // Log each image for debugging
    allImages.forEach((img, i) => {
      const w = img.naturalWidth || img.clientWidth || 0;
      const h = img.naturalHeight || img.clientHeight || 0;
      const src = (img.src || img.dataset?.src || '').substring(0, 80);
      const cls = img.className || '';
      PanelDetector._dbg(`  img[${i}] ${w}x${h} class="${cls}" src="${src}"`);
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
      PanelDetector._dbg(`  Panel ${i + 1}: ${p.element.naturalWidth || p.element.clientWidth}x${p.element.naturalHeight || p.element.clientHeight}`);
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
        PanelDetector._dbg(`SKIPPED: ${img.naturalWidth || img.clientWidth || 0}x${img.naturalHeight || img.clientHeight || 0} src="${(img.src || '').substring(0, 60)}"`);
      }
      return pass;
    });
    PanelDetector._dbg(`Paged filter: ${filtered.length}/${allImages.length} passed`);
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
    if (style.display === 'none' || style.visibility === 'hidden') {
      PanelDetector._dbg(`REJECT: hidden by CSS display="${style.display}" visibility="${style.visibility}"`);
      return false;
    }
    if (parseFloat(style.opacity) === 0) {
      PanelDetector._dbg(`REJECT: opacity=0`);
      return false;
    }

    const width = img.naturalWidth || img.clientWidth || img.width || 0;
    const height = img.naturalHeight || img.clientHeight || img.height || 0;

    // Accept images that have at least some rendered size (clientWidth) even if naturalWidth is 0 (still loading)
    const renderedW = img.clientWidth || 0;
    const renderedH = img.clientHeight || 0;
    if (width === 0 && renderedW === 0) {
      PanelDetector._dbg(`REJECT: width=0`);
      return false;
    }

    // Webtoon strips: at least 200px wide
    if (Math.max(width, renderedW) < 200) {
      PanelDetector._dbg(`REJECT: too narrow ${Math.max(width, renderedW)}px`);
      return false;
    }

    const src = (img.src || img.dataset?.src || '').toLowerCase();
    if (!src || src === 'about:blank') {
      PanelDetector._dbg(`REJECT: no src`);
      return false;
    }

    // Skip ad/UI images
    if (this._isUIImage(src)) {
      PanelDetector._dbg(`REJECT: UI image`);
      return false;
    }

    // Skip very small images that happen to be wide (e.g. separator bars)
    if (Math.max(height, renderedH) < 50) {
      PanelDetector._dbg(`REJECT: too short ${Math.max(height, renderedH)}px`);
      return false;
    }

    PanelDetector._dbg(`✓ WEBTOON ACCEPT: ${width || renderedW}x${height || renderedH}px class="${img.className}" src="${src.substring(0, 50)}"`);
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
   * Caps scan distance and stops early when no new images appear.
   * Critical for SPA/React sites that render images via IntersectionObserver.
   */
  async _scrollScan() {
    PanelDetector._dbg('Scanning page for lazy images...');
    const originalY = window.scrollY;
    const fullHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    // Cap scan at 50 viewport heights — prevents scrolling through entire SPA
    // (a typical manga chapter is 20-30 viewport heights)
    const maxScan = Math.min(fullHeight, window.innerHeight * 50);

    const step = Math.max(window.innerHeight * 0.8, 400);
    let lastImgCount = document.querySelectorAll('img').length;
    let noNewImagesSteps = 0;

    for (let scrollY = 0; scrollY < maxScan; scrollY += step) {
      window.scrollTo({ top: scrollY, behavior: 'instant' });
      window.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 150));

      // Check if new images appeared — if none for 5 consecutive steps, stop early
      const currentImgCount = document.querySelectorAll('img').length;
      if (currentImgCount > lastImgCount) {
        noNewImagesSteps = 0;
        lastImgCount = currentImgCount;
      } else {
        noNewImagesSteps++;
        if (noNewImagesSteps >= 5 && scrollY > window.innerHeight * 3) {
          PanelDetector._dbg(`No new images for ${noNewImagesSteps} steps — stopping scan at ${Math.round(scrollY)}px`);
          break;
        }
      }
    }

    // Scroll back to original position
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 200));
    if (originalY > 0) window.scrollTo({ top: originalY, behavior: 'instant' });
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
   * Force lazy-loaded images to load by copying data-* attrs to src.
   * Also removes native loading="lazy" to force immediate loading.
   */
  _forceLazyLoad() {
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image', 'data-srcset'];
    document.querySelectorAll('img').forEach(img => {
      // Remove native lazy loading to force immediate load
      if (img.loading === 'lazy') {
        img.loading = 'eager';
      }

      if (!img.src || img.src === 'about:blank' || img.src.endsWith('loading.gif') || img.src.includes('pixel.gif')) {
        for (const attr of lazyAttrs) {
          const val = img.getAttribute(attr);
          if (val && (val.startsWith('http') || val.startsWith('/'))) {
            if (attr === 'data-srcset') {
              img.srcset = val;
            } else {
              img.src = val;
            }
            break;
          }
        }
      }
    });
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
