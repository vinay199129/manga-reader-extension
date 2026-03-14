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
  async function sendToTab(msg) {
    if (!activeTabId) return null;
    try {
      return await chrome.tabs.sendMessage(activeTabId, msg);
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

  // --- Button handlers ---
  btnPlay.addEventListener('click', async () => {
    // Ensure scripts are injected first
    await chrome.runtime.sendMessage({ action: 'ensureInjected', tabId: activeTabId });
    // Small delay to let initialization complete
    await new Promise((r) => setTimeout(r, 500));
    const response = await sendToTab({ action: 'play' });
    if (!response) {
      statusBar.textContent = 'Something went wrong — check the page console (F12)';
    }
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
