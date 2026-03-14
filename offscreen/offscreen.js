// offscreen/offscreen.js — Offscreen document for AMBIENT AUDIO ONLY
// OCR has been moved to MAIN world content script.

let audioCtx = null;
let gainNode = null;
let oscillator = null;
let filterNode = null;

const MOOD_CONFIG = {
  dark:     { freq: 55,  vol: 0.06, wave: 'sawtooth' },
  action:   { freq: 82,  vol: 0.08, wave: 'square'   },
  dramatic: { freq: 65,  vol: 0.07, wave: 'sawtooth' },
  bright:   { freq: 130, vol: 0.04, wave: 'sine'     },
  calm:     { freq: 110, vol: 0.03, wave: 'sine'     },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'ambientInit') {
    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 0;
        gainNode.connect(audioCtx.destination);
      }
      // Resume if suspended
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      console.log('[MangaReader Offscreen] Audio context initialized');
      sendResponse({ ok: true });
    } catch (err) {
      console.warn('[MangaReader Offscreen] Init error:', err.message);
      sendResponse({ ok: false, error: err.message });
    }
    return;
  }


  if (msg.action === 'ambientSetMood') {
    try {
      if (!audioCtx || !gainNode) {
        sendResponse({ ok: false, error: 'Audio not initialized' });
        return;
      }

      // Stop previous oscillator
      if (oscillator) {
        try { oscillator.stop(); } catch { /* ignore */ }
        oscillator = null;
      }

      if (msg.mood === 'pause') {
        gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
        sendResponse({ ok: true });
        return;
      }

      const cfg = MOOD_CONFIG[msg.mood] || MOOD_CONFIG.calm;

      oscillator = audioCtx.createOscillator();
      filterNode = audioCtx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.value = 200;

      oscillator.connect(filterNode);
      filterNode.connect(gainNode);

      oscillator.type = cfg.wave;
      oscillator.frequency.value = cfg.freq;
      gainNode.gain.linearRampToValueAtTime(cfg.vol, audioCtx.currentTime + 0.5);

      oscillator.start();
      console.log(`[MangaReader Offscreen] Mood set: ${msg.mood}`);
      sendResponse({ ok: true });
    } catch (err) {
      console.warn('[MangaReader Offscreen] SetMood error:', err.message);
      sendResponse({ ok: false, error: err.message });
    }
    return;
  }

  if (msg.action === 'ambientStop') {
    try {
      if (oscillator) {
        try { oscillator.stop(); } catch { /* ignore */ }
        oscillator = null;
      }
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close();
      }
      audioCtx = null;
      gainNode = null;
      filterNode = null;
      console.log('[MangaReader Offscreen] Audio stopped');
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return;
  }
});

console.log('[MangaReader Offscreen] Offscreen document ready (audio + OCR)');
