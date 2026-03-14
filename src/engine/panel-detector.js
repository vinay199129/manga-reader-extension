// src/engine/panel-detector.js — Finds manga panels on a web page in correct reading order
// Phase 2 upgrade: replace heuristic detect() with ONNX.js model inference.
// Load panel-detector.onnx using onnxruntime-web. The model returns bounding boxes for
// panels AND speech bubbles separately, enabling precise per-bubble OCR and voice assignment.

/**
 * PanelDetector — identifies manga panel images on a page using DOM heuristics.
 */
class PanelDetector {
  /**
   * @param {Object} config
   * @param {string} config.strategy - 'heuristic' (Phase 1) or 'onnx' (Phase 2)
   * @param {number} config.minWidth - Minimum panel width in px
   * @param {number} config.minHeight - Minimum panel height in px
   * @param {string} config.readingDirection - 'ltr' or 'rtl'
   */
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy ?? 'heuristic',
      minWidth: config.minWidth ?? 300,
      minHeight: config.minHeight ?? 200,
      readingDirection: config.readingDirection ?? 'ltr',
    };
    this.observer = null;
  }

  /**
   * Detect all manga panels on the current page.
   * Handles lazy-loaded images by pre-scrolling the page first.
   * @returns {Promise<Array<{element: HTMLImageElement, boundingBox: DOMRect, index: number}>>}
   */
  async detect() {
    // Trigger lazy-loaded images
    await this._waitForImages();

    const allImages = Array.from(document.querySelectorAll('img'));

    const panels = allImages
      .filter((img) => this._isMangaPanel(img))
      .sort((a, b) => this._sortByReadingOrder(a, b))
      .map((element, index) => ({
        element,
        boundingBox: element.getBoundingClientRect(),
        index,
      }));

    // Set up MutationObserver for dynamically added images
    this._observeNewImages();

    console.log(`[MangaReader PanelDetector] Found ${panels.length} panels`);
    return panels;
  }

  /**
   * Check if an image qualifies as a manga panel.
   * @param {HTMLImageElement} img
   * @returns {boolean}
   */
  _isMangaPanel(img) {
    // Skip invisible images
    const style = window.getComputedStyle(img);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    // Skip zero-dimension images
    if (img.naturalWidth === 0 && img.width === 0) return false;
    if (img.naturalHeight === 0 && img.height === 0) return false;

    // Check minimum dimensions
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width < this.config.minWidth || height < this.config.minHeight) return false;

    // Filter out common UI images by src patterns
    const src = (img.src || '').toLowerCase();
    const skipPatterns = ['icon', 'logo', 'avatar', 'banner', 'ad', 'button', 'thumb', 'nav'];
    if (skipPatterns.some((pattern) => src.includes(pattern))) return false;

    // Also check alt text and class for UI indicators
    const alt = (img.alt || '').toLowerCase();
    const className = (img.className || '').toLowerCase();
    if (skipPatterns.some((p) => alt.includes(p) || className.includes(p))) return false;

    return true;
  }

  /**
   * Sort two images by reading order (top-to-bottom, then LTR or RTL).
   * @param {HTMLImageElement} a
   * @param {HTMLImageElement} b
   * @returns {number}
   */
  _sortByReadingOrder(a, b) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();

    // Get absolute positions (account for scroll)
    const topA = rectA.top + window.scrollY;
    const topB = rectB.top + window.scrollY;

    // Primary sort: vertical position (top to bottom)
    const verticalDiff = topA - topB;
    if (Math.abs(verticalDiff) > 50) return verticalDiff;

    // Secondary sort: horizontal position based on reading direction
    if (this.config.readingDirection === 'rtl') {
      return rectB.left - rectA.left; // Right to left
    }
    return rectA.left - rectB.left; // Left to right
  }

  /**
   * Get speech bubble regions for a panel image.
   * Phase 1: returns one region covering the full image (OCR the whole panel).
   * Phase 2+: use ONNX model to find precise bubble bounding boxes.
   * @param {HTMLImageElement} panelElement
   * @returns {Array<{x: number, y: number, width: number, height: number}>}
   */
  getSpeechBubbles(panelElement) {
    // Phase 1: return full image as a single region
    return [{
      x: 0,
      y: 0,
      width: panelElement.naturalWidth || panelElement.width,
      height: panelElement.naturalHeight || panelElement.height,
    }];
  }

  /**
   * Pre-scroll the page to trigger lazy-loaded images, then scroll back.
   */
  async _waitForImages() {
    try {
      const originalScroll = window.scrollY;
      // Scroll to bottom quickly to trigger lazy loaders
      window.scrollTo(0, document.body.scrollHeight);
      await this._sleep(1500);
      // Scroll back to original position
      window.scrollTo(0, originalScroll);
      await this._sleep(500);
    } catch (err) {
      console.warn('[MangaReader PanelDetector] waitForImages error:', err);
    }
  }

  /**
   * Watch for dynamically added images (lazy-load, SPA navigation).
   */
  _observeNewImages() {
    if (this.observer) return; // Already observing
    this.observer = new MutationObserver(() => {
      // New images may have been added — detect() can be re-called by the engine
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  /** @param {number} ms */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Disconnect MutationObserver and clean up */
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}

// Export for both module and script-tag contexts
if (typeof window !== 'undefined') {
  window.PanelDetector = PanelDetector;
}
