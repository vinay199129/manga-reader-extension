// src/bridge.js — ISOLATED world messaging bridge
// Relays messages between chrome.runtime (popup/background) and the engine in MAIN world.
// This file runs in the ISOLATED content script world and has chrome.runtime access.

if (window.__mangaReaderBridgeInit) {
  // Already injected — do nothing
} else {
  window.__mangaReaderBridgeInit = true;

  const SOURCE = 'manga-reader';

  // --- Forward commands from popup/background → MAIN world engine ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'play' || msg.action === 'pause' || msg.action === 'resume' ||
        msg.action === 'stop' || msg.action === 'setVoice' || msg.action === 'setSpeed') {
      window.postMessage({ source: SOURCE, ...msg }, '*');
      sendResponse({ ok: true });
      return false;
    }

    if (msg.action === 'status') {
      // Request status from MAIN world and relay back
      const requestId = 'status_' + Date.now();
      const handler = (event) => {
        if (event.data?.source === SOURCE && event.data?.type === 'statusResponse' &&
            event.data?.requestId === requestId) {
          window.removeEventListener('message', handler);
          sendResponse(event.data.data);
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ source: SOURCE, action: 'status', requestId }, '*');
      return true; // Keep channel open for async response
    }

    return false;
  });

  // --- Forward status updates from MAIN world engine → popup ---
  window.addEventListener('message', (event) => {
    if (event.data?.source !== SOURCE) return;

    // Status broadcast from engine → forward to popup via chrome.runtime
    if (event.data.type === 'status') {
      try {
        chrome.runtime.sendMessage({
          action: 'statusUpdate',
          data: event.data.data,
        });
      } catch {
        // Popup may not be open — ignore
      }
    }

    // Image fetch request from MAIN world → proxy through background.js
    if (event.data.action === 'fetchImage' && event.data.url) {
      const { url, requestId } = event.data;
      chrome.runtime.sendMessage({ action: 'fetchImage', url }, (response) => {
        window.postMessage({
          source: SOURCE,
          type: 'fetchImageResponse',
          requestId,
          dataUrl: response?.dataUrl || null,
          error: response?.error || null,
        }, '*');
      });
    }
  });

  console.log('[MangaReader Bridge] Initialized in ISOLATED world');
}
