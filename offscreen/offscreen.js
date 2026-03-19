// offscreen/offscreen.js — Offscreen document for AMBIENT AUDIO + SFX
// Handles ambient mood audio and manga-style sound effects.

let audioCtx = null;
let gainNode = null;
let oscillator = null;
let filterNode = null;

const MOOD_CONFIG = {
  dark:      { freq: 55,  vol: 0.06, wave: 'sawtooth' },
  action:    { freq: 82,  vol: 0.08, wave: 'square'   },
  dramatic:  { freq: 65,  vol: 0.07, wave: 'sawtooth' },
  bright:    { freq: 130, vol: 0.04, wave: 'sine'     },
  calm:      { freq: 110, vol: 0.03, wave: 'sine'     },
  fire:      { freq: 60,  vol: 0.07, wave: 'sawtooth' },
  lightning: { freq: 100, vol: 0.06, wave: 'square'   },
  impact:    { freq: 45,  vol: 0.08, wave: 'square'   },
};

/**
 * Ensure AudioContext is ready.
 */
function ensureAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0;
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

/**
 * Play a short SFX using Web Audio synthesis.
 * Each SFX is a layered, brief audio event.
 */
function playSFX(type) {
  try {
    ensureAudioCtx();
    const t = audioCtx.currentTime;

    switch (type) {
      case 'sfx_fire': {
        // Crackling fire: burst of filtered noise
        const bufferSize = audioCtx.sampleRate * 0.8;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 800;
        filter.Q.value = 2;
        const sfxGain = audioCtx.createGain();
        sfxGain.gain.setValueAtTime(0.12, t);
        sfxGain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
        noise.connect(filter);
        filter.connect(sfxGain);
        sfxGain.connect(audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.8);
        break;
      }

      case 'sfx_lightning': {
        // Electric zap: sine sweep + noise burst
        const osc = audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(2000, t);
        osc.frequency.exponentialRampToValueAtTime(100, t + 0.15);
        const sfxGain = audioCtx.createGain();
        sfxGain.gain.setValueAtTime(0.15, t);
        sfxGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        osc.connect(sfxGain);
        sfxGain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.3);

        // Thunder rumble follow-up
        const rumbleOsc = audioCtx.createOscillator();
        rumbleOsc.type = 'sawtooth';
        rumbleOsc.frequency.value = 40;
        const rumbleGain = audioCtx.createGain();
        rumbleGain.gain.setValueAtTime(0, t + 0.15);
        rumbleGain.gain.linearRampToValueAtTime(0.08, t + 0.3);
        rumbleGain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
        const rumbleFilter = audioCtx.createBiquadFilter();
        rumbleFilter.type = 'lowpass';
        rumbleFilter.frequency.value = 120;
        rumbleOsc.connect(rumbleFilter);
        rumbleFilter.connect(rumbleGain);
        rumbleGain.connect(audioCtx.destination);
        rumbleOsc.start(t + 0.15);
        rumbleOsc.stop(t + 1.2);
        break;
      }

      case 'sfx_impact': {
        // Punch/explosion: low thud + noise burst
        const thud = audioCtx.createOscillator();
        thud.type = 'sine';
        thud.frequency.setValueAtTime(150, t);
        thud.frequency.exponentialRampToValueAtTime(30, t + 0.2);
        const thudGain = audioCtx.createGain();
        thudGain.gain.setValueAtTime(0.2, t);
        thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        thud.connect(thudGain);
        thudGain.connect(audioCtx.destination);
        thud.start(t);
        thud.stop(t + 0.3);

        // Noise burst
        const bufferSize = audioCtx.sampleRate * 0.15;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.12, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        noise.connect(noiseGain);
        noiseGain.connect(audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.15);
        break;
      }

      case 'sfx_swoosh': {
        // Sword swing: filtered noise sweep
        const bufferSize = audioCtx.sampleRate * 0.3;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1);
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(500, t);
        filter.frequency.exponentialRampToValueAtTime(3000, t + 0.15);
        filter.frequency.exponentialRampToValueAtTime(200, t + 0.3);
        filter.Q.value = 5;
        const sfxGain = audioCtx.createGain();
        sfxGain.gain.setValueAtTime(0.1, t);
        sfxGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        noise.connect(filter);
        filter.connect(sfxGain);
        sfxGain.connect(audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.3);
        break;
      }
    }
    console.log(`[MangaReader Offscreen] SFX played: ${type}`);
  } catch (err) {
    console.warn('[MangaReader Offscreen] SFX error:', err.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'ambientInit') {
    try {
      ensureAudioCtx();
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

  if (msg.action === 'ambientSFX') {
    try {
      ensureAudioCtx();
      playSFX(msg.sfxType);
      sendResponse({ ok: true });
    } catch (err) {
      console.warn('[MangaReader Offscreen] SFX error:', err.message);
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

console.log('[MangaReader Offscreen] Offscreen document ready (ambient audio + SFX)');
