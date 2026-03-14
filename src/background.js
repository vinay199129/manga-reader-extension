// src/background.js — MV3 service worker
// Handles extension lifecycle, script injection, and cross-origin image proxying.

// --- Extension icon click: inject scripts into the active tab ---
chrome.action.onClicked.addListener(async (tab) => {
  await injectScripts(tab.id);
});

/**
 * Inject bridge.js (ISOLATED) and content.js (MAIN) into a tab.
 * Uses chrome.storage.session to avoid double-injection.
 * @param {number} tabId
 */
async function injectScripts(tabId) {
  try {
    // Check if already injected
    const key = `injected_${tabId}`;
    const stored = await chrome.storage.session.get(key);
    if (stored[key]) return;

    // Get the extension's base URL
    const extURL = chrome.runtime.getURL('');

    // First inject a tiny inline script to set the extension URL in MAIN world
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (url) => { window.__mangaReaderExtURL = url; },
      args: [extURL.replace(/\/$/, '')],
    });

    // Inject bridge (ISOLATED world — has chrome.runtime access)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/bridge.js'],
      world: 'ISOLATED',
    });

    // Inject content script (MAIN world — has DOM + library access)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js'],
      world: 'MAIN',
    });

    // Mark as injected
    await chrome.storage.session.set({ [key]: true });
    console.log('[MangaReader BG] Scripts injected into tab', tabId);
  } catch (err) {
    console.error('[MangaReader BG] Injection error:', err);
  }
}

// --- Relay messages between popup ↔ content script ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Cross-origin image fetch proxy
  if (msg.action === 'fetchImage' && msg.url) {
    fetch(msg.url)
      .then((r) => r.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ dataUrl: reader.result });
        reader.readAsDataURL(blob);
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }

  // Status update from content → forward to popup (if popup requests it)
  if (msg.action === 'statusUpdate') {
    // Store latest status so popup can retrieve it
    chrome.storage.session.set({ latestStatus: msg.data });
    return false;
  }

  return false;
});

// --- Handle popup requesting injection when content script isn't loaded yet ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ensureInjected' && msg.tabId) {
    injectScripts(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// --- Clean up session storage when tab is closed ---
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`injected_${tabId}`);
});

console.log('[MangaReader BG] Service worker started');
