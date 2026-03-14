// src/engine/site-adapter.js — Detects manga site type and provides site-specific configuration
// Inspired by Aniyomi/Kotatsu's extension/parser pattern: each site gets an adapter
// that tells the engine about reading direction, layout mode, and content language.

/**
 * SiteAdapter — auto-detects site characteristics for optimal reading experience.
 */
class SiteAdapter {
  constructor() {
    this._siteConfig = null;
  }

  /**
   * Detect site characteristics from the current page.
   * @returns {{ siteName: string, readingDirection: 'ltr'|'rtl', layoutMode: 'paged'|'webtoon'|'auto', language: 'en'|'ja'|'auto', panelSelector: string|null }}
   */
  detect() {
    if (this._siteConfig) return this._siteConfig;

    const host = window.location.hostname.toLowerCase();
    const url = window.location.href.toLowerCase();

    // Try known site patterns first
    const known = this._matchKnownSite(host);
    if (known) {
      this._siteConfig = known;
      console.log(`[MangaReader SiteAdapter] Known site: ${known.siteName} (${known.readingDirection}, ${known.layoutMode}, ${known.language})`);
      return this._siteConfig;
    }

    // Auto-detect from page content
    this._siteConfig = this._autoDetect(host, url);
    console.log(`[MangaReader SiteAdapter] Auto-detected: ${this._siteConfig.siteName} (${this._siteConfig.readingDirection}, ${this._siteConfig.layoutMode}, ${this._siteConfig.language})`);
    return this._siteConfig;
  }

  /**
   * Match against known manga site patterns.
   */
  _matchKnownSite(host) {
    // RTL Japanese raw manga sites
    const rtlJpSites = [
      'raw.senmanga.com', 'rawdevart.com', 'mangaraw.org', 'manga1000.top',
      'klmanga.com', 'rawkuma.com', 'weloma.art',
    ];
    if (rtlJpSites.some(s => host.includes(s))) {
      return { siteName: host, readingDirection: 'rtl', layoutMode: 'paged', language: 'ja', panelSelector: null };
    }

    // Webtoon/long-strip sites (LTR, English)
    const webtoonSites = [
      'webtoons.com', 'tapas.io', 'tappytoon.com', 'lezhin.com',
      'webtoon.xyz', 'manhwatop.com', 'manhuaplus.com',
      'asurascans.com', 'reaperscans.com', 'flamescans.org',
    ];
    if (webtoonSites.some(s => host.includes(s))) {
      return { siteName: host, readingDirection: 'ltr', layoutMode: 'webtoon', language: 'en', panelSelector: null };
    }

    // English manga readers (LTR, paged)
    const ltrEnSites = [
      'mangadex.org', 'mangakakalot.com', 'manganato.com', 'mangareader.to',
      'comick.io', 'comix.to', 'readm.org', 'mangahere.cc',
      'mangafox.me', 'mangapark.to', 'mangasee123.com',
      'chapmanganato.to', 'manganelo.com',
    ];
    if (ltrEnSites.some(s => host.includes(s))) {
      return { siteName: host, readingDirection: 'ltr', layoutMode: 'auto', language: 'en', panelSelector: null };
    }

    return null;
  }

  /**
   * Auto-detect reading direction, layout mode, and language from page content.
   */
  _autoDetect(host, url) {
    const config = {
      siteName: host,
      readingDirection: 'ltr',
      layoutMode: 'auto',
      language: 'en',
      panelSelector: null,
    };

    // --- Detect language ---
    config.language = this._detectLanguage();

    // If Japanese, default to RTL
    if (config.language === 'ja') {
      config.readingDirection = 'rtl';
    }

    // --- Detect layout mode ---
    config.layoutMode = this._detectLayoutMode();

    // --- Detect reading direction from page hints ---
    const dirHint = this._detectDirectionFromPage();
    if (dirHint) config.readingDirection = dirHint;

    return config;
  }

  /**
   * Detect content language by examining page text and meta tags.
   */
  _detectLanguage() {
    // Check <html lang="...">
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (htmlLang.startsWith('ja')) return 'ja';
    if (htmlLang.startsWith('en')) return 'en';
    if (htmlLang.startsWith('ko')) return 'ko';
    if (htmlLang.startsWith('zh')) return 'zh';

    // Check meta tags
    const metaLang = document.querySelector('meta[http-equiv="content-language"]');
    if (metaLang) {
      const val = (metaLang.content || '').toLowerCase();
      if (val.startsWith('ja')) return 'ja';
      if (val.startsWith('ko')) return 'ko';
      if (val.startsWith('zh')) return 'zh';
    }

    // Sample visible text for Japanese characters (hiragana/katakana)
    const bodyText = (document.body?.innerText || '').substring(0, 2000);
    const jpChars = (bodyText.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const koChars = (bodyText.match(/[\uAC00-\uD7AF]/g) || []).length;
    if (jpChars > 20) return 'ja';
    if (koChars > 20) return 'ko';

    return 'en';
  }

  /**
   * Detect if the page uses webtoon (long vertical strip) or paged layout.
   */
  _detectLayoutMode() {
    const images = Array.from(document.querySelectorAll('img'));
    const tallImages = images.filter(img => {
      const h = img.naturalHeight || img.clientHeight || 0;
      const w = img.naturalWidth || img.clientWidth || 0;
      return h > 0 && w > 0 && (h / w > 2.5);
    });

    // Need at least 3 tall images and >40% tall to call it webtoon
    if (tallImages.length >= 3 && images.length > 0 && tallImages.length / images.length > 0.4) {
      console.log(`[MangaReader SiteAdapter] Detected webtoon: ${tallImages.length}/${images.length} tall images`);
      return 'webtoon';
    }

    // Check for common webtoon CSS patterns (full-width stacked images)
    // Use manga-specific selectors only — avoid generic (#content) to prevent false positives
    const container = document.querySelector('.reading-content, .chapter-content, .container-chapter-reader, .reader-images, .chapter-images, .reading-area, [class*="chapter"][class*="content"]');
    if (container) {
      const containerImages = container.querySelectorAll('img');
      if (containerImages.length > 0) {
        const fullWidthCount = Array.from(containerImages).filter(img => {
          const style = window.getComputedStyle(img);
          const displayWidth = img.clientWidth || 0;
          const parentWidth = img.parentElement?.clientWidth || 1;
          return displayWidth / parentWidth > 0.9 || style.maxWidth === '100%' || style.width === '100%';
        }).length;

        if (fullWidthCount / containerImages.length > 0.7) {
          return 'webtoon';
        }
      }
    }

    return 'paged';
  }

  /**
   * Try to detect reading direction from explicit page hints.
   */
  _detectDirectionFromPage() {
    // Check for RTL CSS direction
    const bodyDir = window.getComputedStyle(document.body).direction;
    if (bodyDir === 'rtl') return 'rtl';

    // Check for dir="rtl" on reading containers
    const readingContainer = document.querySelector('.reading-content, .chapter-content, #content, .reader-main');
    if (readingContainer) {
      const dir = readingContainer.getAttribute('dir') || window.getComputedStyle(readingContainer).direction;
      if (dir === 'rtl') return 'rtl';
    }

    // URL-based hints
    const url = window.location.href.toLowerCase();
    if (url.includes('/raw/') || url.includes('-raw') || url.includes('rawmanga')) return 'rtl';

    return null;
  }
}

if (typeof window !== 'undefined') {
  window.SiteAdapter = SiteAdapter;
}
