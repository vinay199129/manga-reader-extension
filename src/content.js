// src/content.js — MAIN world entry point for manga pages
// Loads engine libraries and orchestrates playback. Communicates with extension via postMessage ↔ bridge.js.
// NO chrome.* APIs — runs in MAIN world.

if (window.__mangaReaderInitialised) {
  // Already injected — do nothing
} else {
  window.__mangaReaderInitialised = true;

  const SOURCE = 'manga-reader';
  const EXT_URL = window.__mangaReaderExtURL || '';

  let engine = null;

  /**
   * Load a script from the extension's local bundle.
   * @param {string} path - Relative path within the extension (e.g., 'lib/gsap.min.js')
   * @returns {Promise<void>}
   */
  function loadLocalScript(path) {
    return new Promise((resolve, reject) => {
      const fullUrl = EXT_URL + '/' + path;
      if (document.querySelector(`script[src="${fullUrl}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = fullUrl;
      s.onload = resolve;
      s.onerror = () => {
        console.warn(`[MangaReader] Failed to load: ${path}`);
        resolve(); // Don't block on failure
      };
      document.head.appendChild(s);
    });
  }

  /**
   * Fetch a cross-origin image as a data URL via the bridge → background proxy.
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  function fetchImageAsDataUrl(url) {
    return new Promise((resolve) => {
      const requestId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 15000);

      function handler(event) {
        if (event.data?.source === SOURCE &&
            event.data?.type === 'fetchImageResponse' &&
            event.data?.requestId === requestId) {
          window.removeEventListener('message', handler);
          clearTimeout(timeout);
          resolve(event.data.dataUrl || null);
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ source: SOURCE, action: 'fetchImage', url, requestId }, '*');
    });
  }

  /**
   * Initialize: load libraries, create engine, set up messaging.
   */
  async function init() {
    try {
      // Load libraries in dependency order
      await loadLocalScript('lib/gsap.min.js');
      await loadLocalScript('lib/tesseract/tesseract.min.js');

      // Load engine modules in dependency order
      await loadLocalScript('src/engine/tts.js');
      await loadLocalScript('src/engine/ocr.js');
      await loadLocalScript('src/engine/voice-assigner.js');
      await loadLocalScript('src/engine/panel-detector.js');
      await loadLocalScript('src/engine/manga-engine.js');

      // Build OCR config with resolved local paths
      const ocrConfig = {
        language: 'eng',
        workerPath: EXT_URL + '/lib/tesseract/worker.min.js',
        corePath: EXT_URL + '/lib/tesseract/tesseract-core-simd.wasm.js',
        langPath: EXT_URL + '/lib/tesseract/',
      };

      // Create and initialize engine
      engine = new window.MangaEngine();
      engine.setOCRConfig(ocrConfig);
      await engine.initialize();
      engine.setImageFetcher(fetchImageAsDataUrl);

      console.log('[MangaReader] Content script initialized in MAIN world');
    } catch (err) {
      console.error('[MangaReader] Initialization error:', err);
    }
  }

  // --- Listen for commands from bridge.js (ISOLATED world) ---
  window.addEventListener('message', async (event) => {
    if (event.data?.source !== SOURCE) return;
    if (!engine && event.data.action !== 'status') return;

    const { action } = event.data;

    try {
      switch (action) {
        case 'play':
          engine.play();
          break;
        case 'pause':
          engine.pause();
          break;
        case 'resume':
          engine.resume();
          break;
        case 'stop':
          engine.stop();
          break;
        case 'status': {
          const status = engine ? engine.getStatus() : {
            isPlaying: false, isPaused: false, currentPanel: 0, totalPanels: 0, currentText: '',
          };
          window.postMessage({
            source: SOURCE,
            type: 'statusResponse',
            requestId: event.data.requestId,
            data: status,
          }, '*');
          break;
        }
        case 'setVoice':
          if (event.data.voiceIndex !== undefined) {
            engine.config.voiceIndex = event.data.voiceIndex;
          }
          break;
        case 'setSpeed':
          if (event.data.rate !== undefined) {
            engine.setSpeed(event.data.rate);
          }
          break;
      }
    } catch (err) {
      console.error('[MangaReader] Command error:', action, err);
    }
  });

  // --- Forward engine status events to bridge.js ---
  document.addEventListener('mangareader:status', (event) => {
    window.postMessage({
      source: SOURCE,
      type: 'status',
      data: event.detail,
    }, '*');
  });

  // --- Hook into page unload to clean up ---
  window.addEventListener('beforeunload', () => {
    if (engine) {
      engine.destroy();
    }
  });

  // Start initialization
  init();
}
