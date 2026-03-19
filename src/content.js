// src/content.js — MAIN world entry point for manga pages
// Loads engine libraries and orchestrates playback. Communicates with extension via postMessage ↔ bridge.js.
// NO chrome.* APIs — runs in MAIN world.

if (window.__mangaReaderInitialised) {
  console.log('[MangaReader] Content script already initialized — skipping');
} else {
  window.__mangaReaderInitialised = true;
  console.log('[MangaReader] Content script loading...');

  const SOURCE = 'manga-reader';
  const EXT_URL = window.__mangaReaderExtURL || '';

  // Instance tracking — only the latest content script handles messages
  const _contentInstanceId = Date.now() + '_' + Math.random().toString(36).slice(2);
  window.__mangaReaderContentInstanceId = _contentInstanceId;

  function isActiveContent() {
    return window.__mangaReaderContentInstanceId === _contentInstanceId;
  }

  let engine = null;
  let _engineInitializing = true;
  const _pendingCommands = [];

  /**
   * Load a script from the extension's local bundle.
   */
  function loadLocalScript(path) {
    return new Promise((resolve, reject) => {
      const fullUrl = EXT_URL + '/' + path;
      if (document.querySelector(`script[src="${fullUrl}"]`)) {
        console.log(`[MangaReader] Script already loaded: ${path}`);
        return resolve();
      }
      const s = document.createElement('script');
      s.src = fullUrl;
      s.onload = () => resolve();
      s.onerror = (err) => {
        console.error(`[MangaReader] Failed to load: ${fullUrl}`, err);
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  // --- Proxy helpers: postMessage to bridge → background ---

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

  function captureTabAsDataUrl() {
    return new Promise((resolve) => {
      const requestId = 'cap_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 10000);

      function handler(event) {
        if (event.data?.source === SOURCE &&
            event.data?.type === 'captureTabResponse' &&
            event.data?.requestId === requestId) {
          window.removeEventListener('message', handler);
          clearTimeout(timeout);
          resolve(event.data.dataUrl || null);
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ source: SOURCE, action: 'captureTab', requestId }, '*');
    });
  }

  /**
   * Run a bubble-crop data URL through TrOCR in the offscreen document.
   * Routes: content → bridge → background → offscreen.
   * Falls back silently if TrOCR is unavailable.
   */
  function ocrImageViaBackend(dataUrl) {
    return new Promise((resolve) => {
      const requestId = 'ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(''); // timeout — caller falls back to default OCR
      }, 30000);

      function handler(event) {
        if (event.data?.source === SOURCE &&
            event.data?.type === 'ocrImageResponse' &&
            event.data?.requestId === requestId) {
          window.removeEventListener('message', handler);
          clearTimeout(timeout);
          resolve(event.data.text || '');
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ source: SOURCE, action: 'ocrImage', dataUrl, requestId }, '*');
    });
  }
  /**
   * Returns a Promise that resolves when speech finishes.
   */
  function ttsSpeak(text, options = {}) {
    return new Promise((resolve) => {
      const requestId = 'tts_' + Date.now() + '_' + Math.random().toString(36).slice(2);

      // Listen for TTS completion event from bridge
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; window.removeEventListener('message', endHandler); resolve(); }
      }, 60000); // 60s max per utterance

      function endHandler(event) {
        if (event.data?.source === SOURCE && event.data?.type === 'ttsEvent') {
          const t = event.data.eventType;
          if (t === 'end' || t === 'error' || t === 'interrupted' || t === 'cancelled') {
            if (!resolved) {
              resolved = true;
              window.removeEventListener('message', endHandler);
              clearTimeout(timeout);
              resolve();
            }
          }
        }
      }
      window.addEventListener('message', endHandler);

      // Also listen for the initial response (confirms speak was accepted)
      function ackHandler(event) {
        if (event.data?.source === SOURCE &&
            event.data?.type === 'ttsSpeakResponse' &&
            event.data?.requestId === requestId) {
          window.removeEventListener('message', ackHandler);
          if (!event.data.ok && !resolved) {
            resolved = true;
            window.removeEventListener('message', endHandler);
            clearTimeout(timeout);
            console.warn('[MangaReader] TTS speak rejected:', event.data.error);
            resolve();
          }
        }
      }
      window.addEventListener('message', ackHandler);

      window.postMessage({
        source: SOURCE,
        action: 'ttsSpeak',
        requestId,
        text,
        rate: options.rate || 1.0,
        pitch: options.pitch || 1.0,
        volume: options.volume || 1.0,
        voiceName: options.voiceName || undefined,
        lang: options.lang || 'en-US',
      }, '*');
    });
  }

  function ttsStop() {
    window.postMessage({ source: SOURCE, action: 'ttsStop' }, '*');
  }

  function ttsPause() {
    window.postMessage({ source: SOURCE, action: 'ttsPause' }, '*');
  }

  function ttsResume() {
    window.postMessage({ source: SOURCE, action: 'ttsResume' }, '*');
  }

  function ttsGetVoices() {
    return new Promise((resolve) => {
      const requestId = 'voices_' + Date.now();
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve([]);
      }, 5000);

      function handler(event) {
        if (event.data?.source === SOURCE &&
            event.data?.type === 'ttsGetVoicesResponse' &&
            event.data?.requestId === requestId) {
          window.removeEventListener('message', handler);
          clearTimeout(timeout);
          resolve(event.data.voices || []);
        }
      }
      window.addEventListener('message', handler);
      window.postMessage({ source: SOURCE, action: 'ttsGetVoices', requestId }, '*');
    });
  }

  /**
   * Ambient audio proxy — sends commands to offscreen document via bridge → background.
   */
  function ambientInit() {
    window.postMessage({ source: SOURCE, action: 'ambientInit' }, '*');
  }

  function ambientSetMood(mood) {
    window.postMessage({ source: SOURCE, action: 'ambientSetMood', mood }, '*');
  }

  function ambientStop() {
    window.postMessage({ source: SOURCE, action: 'ambientStop' }, '*');
  }

  /**
   * Initialize: load libraries, create engine, set up messaging.
   */
  // Debug flag — enable verbose logging via: window.__mangaReaderDebug = true
  function _dbg(...args) {
    if (window.__mangaReaderDebug) console.log('[MangaReader]', ...args);
  }

  async function init() {
    console.log('[MangaReader] init() starting — EXT_URL:', EXT_URL || '(EMPTY!)');
    try {
      // Load GSAP for animations
      await loadLocalScript('lib/gsap.min.js');
      _dbg('GSAP loaded:', !!window.gsap);

      // Load engine modules
      const modules = [
        'src/engine/tts.js',
        'src/engine/ocr.js',
        'src/engine/character-registry.js',
        'src/engine/voice-assigner.js',
        'src/engine/panel-detector.js',
        'src/engine/site-adapter.js',
        'src/engine/manga-engine.js',
      ];
      for (const mod of modules) {
        await loadLocalScript(mod);
      }

      // Verify critical classes exist
      const missing = ['TTSEngine', 'OCREngine', 'CharacterRegistry', 'VoiceAssigner', 'PanelDetector', 'MangaEngine']
        .filter(cls => !window[cls]);
      if (missing.length > 0) {
        throw new Error(`Missing classes after script load: ${missing.join(', ')}. EXT_URL=${EXT_URL}`);
      }
      console.log('[MangaReader] All engine modules loaded');

      const ocrConfig = { language: 'eng' };

      // Build TTS proxy object that the engine will use
      const ttsProxy = {
        speak: ttsSpeak,
        stop: ttsStop,
        pause: ttsPause,
        resume: ttsResume,
        getVoices: ttsGetVoices,
        setRate: () => {}, // Rate is passed per-speak call
      };

      // Create and initialize engine
      engine = new window.MangaEngine();
      engine.setTTSProxy(ttsProxy);
      await engine.initialize();
      engine.setImageFetcher(fetchImageAsDataUrl);
      engine.setAmbientProxy({
        init: ambientInit,
        setMood: ambientSetMood,
        stop: ambientStop,
      });
      engine.setTabCaptureFn(captureTabAsDataUrl);

      // Apply Enhanced OCR if it was pre-set before engine was ready
      if (window.__mangaReaderEnhancedOCR) {
        engine.setEnhancedOCRFn(ocrImageViaBackend);
        console.log('[MangaReader] Enhanced OCR ✓ ENABLED (downloading ~60 MB model on first use)');
      }

      _engineInitializing = false;
      console.log('[MangaReader] Content script initialized');

      // Replay any commands that arrived while we were initializing
      if (_pendingCommands.length > 0) {
        console.log(`[MangaReader] Replaying ${_pendingCommands.length} queued command(s)`);
        _pendingCommands.forEach(cmd => {
          window.postMessage(cmd, '*');
        });
        _pendingCommands.length = 0;
      }
    } catch (err) {
      _engineInitializing = false;
      console.error('[MangaReader] Initialization error:', err);
    }
  }

  // --- Listen for commands from bridge.js (ISOLATED world) ---
  window.addEventListener('message', async (event) => {
    if (event.data?.source !== SOURCE) return;
    if (!isActiveContent()) return; // Superseded by newer injection

    const { action } = event.data;

    // If engine is still initializing, queue actionable commands for replay
    if (!engine) {
      if (action === 'setDebug') {
        window.__mangaReaderDebug = !!event.data.enabled;
        return;
      }
      if (action === 'setEnhancedOCR') {
        window.__mangaReaderEnhancedOCR = !!event.data.enabled;
        return;
      }
      if (action === 'status') {
        // Always respond to status — report initializing state
        window.postMessage({
          source: SOURCE,
          type: 'statusResponse',
          requestId: event.data.requestId,
          data: _engineInitializing
            ? { isPlaying: false, isPaused: false, currentPanel: 0, totalPanels: 0, currentText: 'Initializing...' }
            : { isPlaying: false, isPaused: false, currentPanel: 0, totalPanels: 0, currentText: 'Init failed' },
        }, '*');
        return;
      }
      if (_engineInitializing && (action === 'play' || action === 'redetect')) {
        console.log(`[MangaReader] Engine initializing — queuing '${action}'`);
        _pendingCommands.push(event.data);
        return;
      }
      return;
    }

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
        case 'setVoiceB':
          if (event.data.voiceIndex !== undefined) {
            engine.setVoiceB(event.data.voiceIndex);
          }
          break;
        case 'setSpeed':
          if (event.data.rate !== undefined) {
            engine.setSpeed(event.data.rate);
          }
          break;
        case 'setDebug':
          window.__mangaReaderDebug = !!event.data.enabled;
          _dbg('Debug mode:', window.__mangaReaderDebug);
          break;
        case 'setEnhancedOCR':
          window.__mangaReaderEnhancedOCR = !!event.data.enabled;
          if (engine) engine.setEnhancedOCRFn(event.data.enabled ? ocrImageViaBackend : null);
          console.log(`[MangaReader] Enhanced OCR ${event.data.enabled ? '✓ ENABLED (downloading ~60 MB model on first use)' : '✗ DISABLED'}`);
          _dbg('Enhanced OCR:', event.data.enabled);
          break;
        case 'redetect':
          if (engine && engine.panelDetector) {
            engine.panelDetector.detect().then(panels => {
              engine.panels = panels;
              engine.emitStatus();
              console.log(`[MangaReader] Re-detected ${panels.length} panels`);
            });
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

  // --- Clean up on page unload ---
  window.addEventListener('beforeunload', () => {
    if (engine) engine.destroy();
  });

  init();
}
