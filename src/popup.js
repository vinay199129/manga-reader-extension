// src/popup.js — Controls popup UI and communicates with content script via chrome.tabs.sendMessage

(function () {
  'use strict';

  const btnPlay = document.getElementById('btnPlay');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');
  const statusBar = document.getElementById('statusBar');
  const currentText = document.getElementById('currentText');
  const voiceSelect = document.getElementById('voiceSelect');
  const speedSlider = document.getElementById('speedSlider');
  const speedVal = document.getElementById('speedVal');

  let activeTabId = null;

  // --- Get active tab ---
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // --- Send message to content script (via bridge in ISOLATED world) ---
  async function sendToTab(msg, timeoutMs = 5000) {
    if (!activeTabId) return null;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(activeTabId, msg),
        new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
      ]);
    } catch {
      return null;
    }
  }

  // --- Update UI based on engine status ---
  function updateUI(status) {
    if (!status) {
      statusBar.textContent = 'Click the extension icon on a manga page to start';
      statusBar.classList.remove('active');
      btnPlay.disabled = false;
      btnPause.disabled = true;
      btnStop.disabled = true;
      return;
    }

    if (status.totalPanels === 0) {
      statusBar.textContent = 'No manga panels detected on this page';
      statusBar.classList.remove('active');
    } else if (status.isPlaying && !status.isPaused) {
      statusBar.textContent = `Playing panel ${status.currentPanel + 1} / ${status.totalPanels}`;
      statusBar.classList.add('active');
    } else if (status.isPaused) {
      statusBar.textContent = `Paused — panel ${status.currentPanel + 1} / ${status.totalPanels}`;
      statusBar.classList.remove('active');
    } else {
      statusBar.textContent = `Ready — ${status.totalPanels} panels detected`;
      statusBar.classList.remove('active');
    }

    currentText.textContent = status.currentText || '—';

    btnPlay.disabled = status.isPlaying && !status.isPaused;
    btnPause.disabled = !status.isPlaying || status.isPaused;
    btnStop.disabled = !status.isPlaying && !status.isPaused;
  }

  // --- Populate voice dropdown ---
  function populateVoices() {
    const synth = window.speechSynthesis;
    const loadVoices = () => {
      const voices = synth.getVoices();
      voiceSelect.innerHTML = '';
      if (voices.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'Loading voices...';
        voiceSelect.appendChild(opt);
        return;
      }
      voices.forEach((voice, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${voice.name} (${voice.lang})`;
        voiceSelect.appendChild(opt);
      });
    };

    loadVoices();
    if (synth.getVoices().length === 0) {
      synth.addEventListener('voiceschanged', loadVoices, { once: true });
    }
  }

  // --- Wait for engine to be ready (scripts loaded + init complete) ---
  async function waitForEngine(maxWait = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = await sendToTab({ action: 'status' });
      console.log('[MangaReader Popup] Poll result:', status);
      // totalPanels of -1 means bridge timeout (content.js not loaded yet)
      if (status && status.totalPanels !== undefined && status.totalPanels >= 0) return status;
      await new Promise(r => setTimeout(r, 600));
    }
    return null;
  }

  // --- Button handlers ---
  btnPlay.addEventListener('click', async () => {
    btnPlay.disabled = true;

    // Make sure we have the tab
    if (!activeTabId) {
      const tab = await getActiveTab();
      if (tab) activeTabId = tab.id;
    }
    if (!activeTabId) {
      statusBar.textContent = 'Cannot find active tab — try reopening the popup';
      btnPlay.disabled = false;
      return;
    }

    statusBar.textContent = 'Injecting scripts...';
    console.log('[MangaReader Popup] Injecting into tab', activeTabId);

    // Ensure scripts are injected
    let injectResult;
    try {
      injectResult = await chrome.runtime.sendMessage({ action: 'ensureInjected', tabId: activeTabId });
    } catch (err) {
      statusBar.textContent = `Injection error: ${err.message}`;
      btnPlay.disabled = false;
      return;
    }

    console.log('[MangaReader Popup] Injection result:', injectResult);

    if (!injectResult?.ok) {
      const errMsg = injectResult?.error || 'Unknown error';
      if (errMsg.includes('Cannot access') || errMsg.includes('file://')) {
        statusBar.textContent = 'Enable "Allow access to file URLs" in chrome://extensions for this extension';
      } else {
        statusBar.textContent = `Injection failed: ${errMsg}`;
      }
      btnPlay.disabled = false;
      return;
    }

    // Wait for engine to initialize (script loading + panel detection)
    statusBar.textContent = 'Loading engine...';
    const status = await waitForEngine(15000);
    if (!status) {
      statusBar.textContent = 'Engine initialization timed out — check the page console (F12)';
      btnPlay.disabled = false;
      return;
    }

    // Now send play
    statusBar.textContent = 'Starting playback...';
    const response = await sendToTab({ action: 'play' });
    if (!response) {
      statusBar.textContent = 'Play command failed — check the page console (F12)';
    }
    btnPlay.disabled = false;
  });

  btnPause.addEventListener('click', () => sendToTab({ action: 'pause' }));
  btnStop.addEventListener('click', () => sendToTab({ action: 'stop' }));

  voiceSelect.addEventListener('change', () => {
    sendToTab({ action: 'setVoice', voiceIndex: parseInt(voiceSelect.value, 10) });
  });

  speedSlider.addEventListener('input', () => {
    const rate = parseFloat(speedSlider.value);
    speedVal.textContent = rate.toFixed(1);
    sendToTab({ action: 'setSpeed', rate });
  });

  // --- Listen for status updates from content script ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'statusUpdate' && msg.data) {
      updateUI(msg.data);
    }
  });

  // --- Poll for status updates (backup in case events are missed) ---
  let pollInterval = null;

  async function pollStatus() {
    const status = await sendToTab({ action: 'status' });
    if (status) updateUI(status);
  }

  // --- Init ---
  async function init() {
    const tab = await getActiveTab();
    if (tab) {
      activeTabId = tab.id;
    }

    populateVoices();

    // Request initial status
    const status = await sendToTab({ action: 'status' });
    updateUI(status);

    // Poll every 2 seconds as a fallback
    pollInterval = setInterval(pollStatus, 2000);
  }

  init();
})();
