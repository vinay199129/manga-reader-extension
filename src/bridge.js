// src/bridge.js — ISOLATED world messaging bridge
// Relays messages between chrome.runtime (popup/background) and the engine in MAIN world.
// This file runs in the ISOLATED content script world and has chrome.runtime access.

if (window.__mangaReaderBridgeInit) {
  // Already injected — do nothing
} else {
  window.__mangaReaderBridgeInit = true;

  const SOURCE = 'manga-reader';
  let _contextDead = false;

  // Instance tracking: each injection gets a unique ID.
  // Only the latest bridge instance should handle messages.
  const _bridgeInstanceId = Date.now() + '_' + Math.random().toString(36).slice(2);
  window.__mangaReaderBridgeInstanceId = _bridgeInstanceId;

  function isActiveBridge() {
    return window.__mangaReaderBridgeInstanceId === _bridgeInstanceId;
  }

  // Remove any stale reload banner from a previous injection
  const oldBanner = document.getElementById('manga-reader-reload-banner');
  if (oldBanner) oldBanner.remove();

  /**
   * Check if the extension context is still alive.
   * After an extension reload/update, old content scripts lose their port.
   */
  function isContextAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /**
   * Show a non-intrusive banner telling the user to refresh.
   */
  function showReloadBanner() {
    if (_contextDead) return; // already shown
    _contextDead = true;
    const banner = document.createElement('div');
    banner.id = 'manga-reader-reload-banner';
    banner.textContent = '⟳ Manga Reader extension was updated — please refresh this page (F5)';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:100%', 'z-index:999999',
      'background:#e94560', 'color:#fff', 'text-align:center',
      'padding:10px 16px', 'font:14px/1.4 system-ui,sans-serif',
      'cursor:pointer', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
    ].join(';');
    banner.addEventListener('click', () => location.reload());
    document.body.appendChild(banner);
  }

  // Helper: safe chrome.runtime.sendMessage with context-invalidated guard
  function safeSend(msg, callback) {
    if (_contextDead || !isContextAlive()) {
      showReloadBanner();
      callback?.({ error: 'Extension context invalidated — reload the page' });
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || '';
          console.warn('[MangaReader Bridge] sendMessage error:', errMsg);
          if (errMsg.includes('invalidated') || errMsg.includes('port closed')) {
            showReloadBanner();
          }
          callback?.({ error: errMsg });
          return;
        }
        callback?.(response);
      });
    } catch (err) {
      console.warn('[MangaReader Bridge] Extension context error:', err.message);
      showReloadBanner();
      callback?.({ error: 'Extension context invalidated — reload the page' });
    }
  }

  // --- Forward commands from popup/background → MAIN world engine ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Stale bridge: another instance superseded us — stop handling
    if (!isActiveBridge()) return false;

    if (msg.action === 'play' || msg.action === 'pause' || msg.action === 'resume' ||
        msg.action === 'stop' || msg.action === 'setVoice' || msg.action === 'setVoiceB' ||
        msg.action === 'setSpeed' || msg.action === 'setDebug' || msg.action === 'setEnhancedOCR') {
      window.postMessage({ source: SOURCE, ...msg }, '*');
      sendResponse({ ok: true });
      return false;
    }

    // Forward TTS completion events from background → MAIN world
    if (msg.action === 'ttsEvent') {
      window.postMessage({ source: SOURCE, type: 'ttsEvent', eventType: msg.eventType }, '*');
      return false;
    }

    if (msg.action === 'status') {
      const requestId = 'status_' + Date.now();
      let responded = false;

      // Timeout: if content.js doesn't respond in 4s, return a fallback
      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          window.removeEventListener('message', handler);
          console.warn('[MangaReader Bridge] Status request timed out (content.js not responding)');
          sendResponse({ isPlaying: false, isPaused: false, currentPanel: 0, totalPanels: -1, currentText: 'Bridge timeout' });
        }
      }, 4000);

      const handler = (event) => {
        if (event.data?.source === SOURCE && event.data?.type === 'statusResponse' &&
            event.data?.requestId === requestId) {
          if (!responded) {
            responded = true;
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            sendResponse(event.data.data);
          }
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: SOURCE, action: 'status', requestId }, '*');
      return true;
    }

    return false;
  });

  // --- Forward requests from MAIN world → background ---
  window.addEventListener('message', (event) => {
    if (event.data?.source !== SOURCE) return;
    // Stale bridge: another instance superseded us — stop handling
    if (!isActiveBridge()) return;

    // Status broadcast from engine → forward to popup
    if (event.data.type === 'status') {
      safeSend({ action: 'statusUpdate', data: event.data.data });
    }

    // Image fetch request
    if (event.data.action === 'fetchImage' && event.data.url) {
      const { url, requestId } = event.data;
      safeSend({ action: 'fetchImage', url }, (response) => {
        window.postMessage({
          source: SOURCE,
          type: 'fetchImageResponse',
          requestId,
          dataUrl: response?.dataUrl || null,
          error: response?.error || null,
        }, '*');
      });
    }


    // --- Capture visible tab screenshot (for gutter scanning) ---
    if (event.data.action === 'captureTab') {
      const { requestId } = event.data;
      safeSend({ action: 'captureTab' }, (response) => {
        window.postMessage({
          source: SOURCE,
          type: 'captureTabResponse',
          requestId,
          dataUrl: response?.dataUrl || null,
          error: response?.error || null,
        }, '*');
      });
    }

    // --- Enhanced OCR: route dataUrl to TrOCR in offscreen ---
    if (event.data.action === 'ocrImage') {
      const { requestId, dataUrl } = event.data;
      safeSend({ action: 'ocrImage', dataUrl }, (response) => {
        window.postMessage({
          source: SOURCE,
          type: 'ocrImageResponse',
          requestId,
          text: response?.text || '',
          error: response?.error || null,
        }, '*');
      });
    }

    // --- TTS: Speak via chrome.tts in background ---
    if (event.data.action === 'ttsSpeak') {
      const { text, rate, pitch, volume, voiceName, lang, requestId } = event.data;
      safeSend({ action: 'ttsSpeak', text, rate, pitch, volume, voiceName, lang }, (response) => {
        window.postMessage({
          source: SOURCE,
          type: 'ttsSpeakResponse',
          requestId,
          ok: response?.ok || false,
          error: response?.error || null,
        }, '*');
      });
    }

    // --- TTS: Stop ---
    if (event.data.action === 'ttsStop') {
      safeSend({ action: 'ttsStop' });
    }

    // --- TTS: Pause ---
    if (event.data.action === 'ttsPause') {
      safeSend({ action: 'ttsPause' });
    }

    // --- TTS: Resume ---
    if (event.data.action === 'ttsResume') {
      safeSend({ action: 'ttsResume' });
    }

    // --- TTS: Get voices ---
    if (event.data.action === 'ttsGetVoices') {
      const { requestId } = event.data;
      safeSend({ action: 'ttsGetVoices' }, (response) => {
        window.postMessage({
          source: SOURCE,
          type: 'ttsGetVoicesResponse',
          requestId,
          voices: response?.voices || [],
        }, '*');
      });
    }

    // --- Ambient audio: Init/SetMood/Stop/SFX via offscreen ---
    if (event.data.action === 'ambientInit' || event.data.action === 'ambientSetMood' || event.data.action === 'ambientStop') {
      safeSend({ action: event.data.action, mood: event.data.mood });
    }

    if (event.data.action === 'ambientSFX') {
      safeSend({ action: 'ambientSFX', sfxType: event.data.sfxType });
    }
  });

  // Periodic liveness check — detect stale context early
  const _aliveCheck = setInterval(() => {
    if (!isActiveBridge()) {
      clearInterval(_aliveCheck);
      return; // Superseded by newer bridge — stop silently
    }
    if (!isContextAlive()) {
      clearInterval(_aliveCheck);
      showReloadBanner();
      return;
    }
    // Keep-alive ping — prevents service worker from sleeping during playback
    try {
      chrome.runtime.sendMessage({ action: 'keepAlive' }, () => {
        // Suppress Chrome's "Unchecked runtime.lastError" warning for keep-alive pings
        void chrome.runtime.lastError;
      });
    } catch { /* context may be dead */ }
  }, 20000); // every 20s (service worker has 30s timeout)

  console.log('[MangaReader Bridge] Initialized in ISOLATED world. Instance:', _bridgeInstanceId);
}
