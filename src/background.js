// src/background.js — MV3 service worker
// Handles extension lifecycle, script injection, cross-origin proxying,
// chrome.tts for narration, and offscreen document for ambient audio.

console.log('[MangaReader BG] Service worker loaded');

// --- Extension icon click: inject scripts into the active tab ---
chrome.action.onClicked.addListener(async (tab) => {
  await injectScripts(tab.id);
});

/**
 * Inject bridge.js (ISOLATED) and content.js (MAIN) into a tab.
 * Uses chrome.storage.session to avoid double-injection.
 */
async function injectScripts(tabId) {
  try {
    const key = `injected_${tabId}`;
    const stored = await chrome.storage.session.get(key);
    if (stored[key]) return { ok: true, alreadyInjected: true };

    const extURL = chrome.runtime.getURL('');

    // Clear guard flags so the scripts run even if stale ones were left over
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (url) => {
        window.__mangaReaderExtURL = url;
        window.__mangaReaderInitialised = false;
      },
      args: [extURL.replace(/\/$/, '')],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => { window.__mangaReaderBridgeInit = false; },
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/bridge.js'],
      world: 'ISOLATED',
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js'],
      world: 'MAIN',
    });

    await chrome.storage.session.set({ [key]: true });
    console.log('[MangaReader BG] Scripts injected into tab', tabId);
    return { ok: true };
  } catch (err) {
    console.error('[MangaReader BG] Injection error:', err);
    return { ok: false, error: err.message };
  }
}

// ============================================================
//  OFFSCREEN DOCUMENT MANAGEMENT (for ambient audio)
// ============================================================

// Singleton promise to prevent race conditions during multiple rapid requests
let _offscreenCreating = null;

async function ensureOffscreen() {
  const path = 'offscreen/offscreen.html';
  
  if (_offscreenCreating) return _offscreenCreating;

  _offscreenCreating = (async () => {
    try {
      // Check if it exists first
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(path)],
      });
      
      if (contexts.length > 0) return;

      // Create if missing
      await chrome.offscreen.createDocument({
        url: path,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Ambient audio playback',
      });
      console.log('[MangaReader BG] Offscreen document created');
    } catch (err) {
      if (err.message.includes('Only one offscreen')) return; // Race condition safety net
      console.warn('[MangaReader BG] Offscreen creation failed:', err);
      throw err;
    } finally {
      _offscreenCreating = null;
    }
  })();

  return _offscreenCreating;
}

// ============================================================
//  MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    // --- Handle popup requesting injection ---
    if (msg.action === 'ensureInjected' && msg.tabId) {
      injectScripts(msg.tabId).then((result) => sendResponse(result));
      return true;
    }

    // --- Capture visible tab screenshot (for gutter scanning) ---
    if (msg.action === 'captureTab') {
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      });
      return true;
    }

    // --- Cross-origin image fetch proxy ---
    if (msg.action === 'fetchImage' && msg.url) {
      console.log('[MangaReader Background] Fetching image:', msg.url.substring(0, 80));
      fetch(msg.url)
        .then((r) => {
          console.log('[MangaReader Background] Fetch response:', r.status, r.statusText);
          return r.blob();
        })
        .then((blob) => {
          console.log('[MangaReader Background] Got blob:', blob.size, 'bytes, type:', blob.type);
          const reader = new FileReader();
          reader.onloadend = () => {
            console.log('[MangaReader Background] Converted to dataUrl:', reader.result?.substring(0, 100));
            sendResponse({ dataUrl: reader.result });
          };
          reader.readAsDataURL(blob);
        })
        .catch((err) => {
          console.error('[MangaReader Background] Fetch error:', err.message);
          sendResponse({ error: err.message });
        });
      return true;
    }


    // --- chrome.tts: Speak text (no user gesture needed!) ---
    if (msg.action === 'ttsSpeak' && msg.text) {
      const tabId = sender.tab?.id;
      
      // CRITICAL: Send response FIRST, before calling chrome.tts.speak
      // This prevents "port closed before response" errors
      sendResponse({ ok: true });
      
      // Now speak (async via onEvent callback)
      try {
        console.log(`[MangaReader BG] Speaking: "${msg.text.substring(0, 50)}..."`);
        chrome.tts.speak(msg.text, {
          rate: msg.rate || 1.0,
          pitch: msg.pitch || 1.0,
          volume: msg.volume || 1.0,
          voiceName: msg.voiceName || undefined,
          lang: msg.lang || 'en-US',
          enqueue: false,
          onEvent: (event) => {
            if (event.type === 'end' || event.type === 'error' ||
                event.type === 'interrupted' || event.type === 'cancelled') {
              if (tabId) {
                try {
                  chrome.tabs.sendMessage(tabId, {
                    action: 'ttsEvent',
                    eventType: event.type,
                  });
                } catch { /* tab may be closed */ }
              }
            }
          },
        });
      } catch (err) {
        console.error('[MangaReader BG] TTS speak error:', err);
        // Already sent OK response, can't send error now
        // Event callback will fire with error type
      }
      return false; // Response already sent
    }

    // --- chrome.tts: Stop ---
    if (msg.action === 'ttsStop') {
      chrome.tts.stop();
      sendResponse({ ok: true });
      return false;
    }

    // --- chrome.tts: Pause ---
    if (msg.action === 'ttsPause') {
      chrome.tts.pause();
      sendResponse({ ok: true });
      return false;
    }

    // --- chrome.tts: Resume ---
    if (msg.action === 'ttsResume') {
      chrome.tts.resume();
      sendResponse({ ok: true });
      return false;
    }

    // --- chrome.tts: Get voices ---
    if (msg.action === 'ttsGetVoices') {
      chrome.tts.getVoices((voices) => {
        sendResponse({ voices: (voices || []).map((v) => ({ name: v.voiceName, lang: v.lang })) });
      });
      return true;
    }

    // --- Ambient audio: forward to offscreen document ---
    if (msg.action === 'ambientInit' || msg.action === 'ambientSetMood' || msg.action === 'ambientStop' || msg.action === 'ambientSFX') {
      ensureOffscreen().then(() => {
        try {
          chrome.runtime.sendMessage({ target: 'offscreen', ...msg }, (response) => {
            if (chrome.runtime.lastError) {
               sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
               sendResponse(response || { ok: true });
            }
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      }).catch(err => {
         sendResponse({ ok: false, error: 'Ambient offscreen setup failed' });
      });
      return true;
    }

    // --- Enhanced OCR (TrOCR): forward to offscreen document ---
    if (msg.action === 'ocrImage') {
      ensureOffscreen().then(() => {
        try {
          chrome.runtime.sendMessage({ target: 'offscreen', action: 'ocrImage', dataUrl: msg.dataUrl }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ text: '', error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { text: '' });
            }
          });
        } catch (err) {
          sendResponse({ text: '', error: err.message });
        }
      }).catch(() => {
        sendResponse({ text: '', error: 'Offscreen setup failed' });
      });
      return true;
    }

    // --- Status update from content → store for popup ---
    if (msg.action === 'statusUpdate') {
      chrome.storage.session.set({ latestStatus: msg.data });
      sendResponse({ ok: true });
      return false;
    }

    // --- Keep-alive ping from bridge to prevent service worker sleep ---
    if (msg.action === 'keepAlive') {
      sendResponse({ ok: true });
      return false;
    }

    // --- Unknown action: don't send response, let other handlers try ---
    return false;
  } catch (err) {
    console.error('[MangaReader BG] Top-level onMessage exception:', err);
    try { sendResponse({ error: 'Background script exception: ' + err.message }); } catch { /* ignore */ }
    return false;
  }
});

// --- Clean up on tab close ---
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`injected_${tabId}`);
});

// --- Clear injection flag when a tab navigates/refreshes ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.session.remove(`injected_${tabId}`);
  }
});

// On service worker start-up, clear all stale injection flags
// so scripts get re-injected after extension reload/update.
chrome.storage.session.get(null, (items) => {
  const staleKeys = Object.keys(items || {}).filter(k => k.startsWith('injected_'));
  if (staleKeys.length > 0) {
    chrome.storage.session.remove(staleKeys);
    console.log('[MangaReader BG] Cleared', staleKeys.length, 'stale injection flags');
  }
});

console.log('[MangaReader BG] Service worker started');
