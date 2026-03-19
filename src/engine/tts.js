// src/engine/tts.js — Text-to-speech wrapper
// In Chrome extension context, delegates to chrome.tts via proxy (no user gesture needed).
// The proxy is injected by content.js → bridge.js → background.js.
// NO chrome.* APIs here — pure JS for mobile reuse.

/**
 * TTSEngine — wraps TTS functionality.
 * In proxy mode: delegates to chrome.tts via postMessage chain.
 * In direct mode (fallback / mobile): uses window.speechSynthesis.
 */
class TTSEngine {
  static _dbg(...args) { if (typeof window !== 'undefined' && window.__mangaReaderDebug) console.log('[MangaReader TTS]', ...args); }

  constructor(config = {}) {
    this.config = {
      rate: config.rate ?? 1.0,
      pitch: config.pitch ?? 1.0,
      volume: config.volume ?? 1.0,
    };
    this.voices = [];
    this._proxy = null; // Set via setProxy()
  }

  /**
   * Set the TTS proxy object. Must have: speak(text, options), stop(), pause(), resume(), getVoices().
   */
  setProxy(proxy) {
    this._proxy = proxy;
    TTSEngine._dbg('Proxy mode enabled');
  }

  /**
   * Load available voices.
   */
  async getVoices() {
    if (this._proxy) {
      try {
        this.voices = await this._proxy.getVoices();
        TTSEngine._dbg(`${this.voices.length} voices available via proxy`);
      } catch {
        this.voices = [];
      }
      return this.voices;
    }

    // Direct mode fallback (window.speechSynthesis)
    const synth = window.speechSynthesis;
    let voices = synth.getVoices();
    if (voices.length > 0) {
      this.voices = voices;
      return this.voices;
    }
    return new Promise((resolve) => {
      const handler = () => {
        synth.removeEventListener('voiceschanged', handler);
        this.voices = synth.getVoices();
        resolve(this.voices);
      };
      synth.addEventListener('voiceschanged', handler);
    });
  }

  /**
   * Speak text. Returns Promise that resolves when speech completes.
   */
  speak(text, voiceIndex = 0) {
    if (this._proxy) {
      return this._speakViaProxy(text, voiceIndex);
    }
    return this._speakDirect(text, voiceIndex);
  }

  /**
   * Proxy mode: speak via chrome.tts (routed through content.js → bridge → background).
   */
  _speakViaProxy(text, voiceIndex) {
    const voice = this.voices[voiceIndex];
    TTSEngine._dbg(`Speaking (rate ${this.config.rate}): "${text.substring(0, 60)}"`);
    return this._proxy.speak(text, {
      rate: this.config.rate,
      pitch: this.config.pitch,
      volume: this.config.volume,
      voiceName: voice?.name || undefined,
      lang: voice?.lang || 'en-US',
    });
  }

  /**
   * Direct mode: speak via window.speechSynthesis (mobile fallback).
   */
  _speakDirect(text, voiceIndex) {
    return new Promise((resolve, reject) => {
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = this.voices[voiceIndex] || null;
        utterance.rate = this.config.rate;
        utterance.pitch = this.config.pitch;
        utterance.volume = this.config.volume;

        TTSEngine._dbg(`Speaking direct (rate ${this.config.rate}): "${text.substring(0, 60)}"`);

        const checkInterval = setInterval(() => {
          if (!window.speechSynthesis.speaking) clearInterval(checkInterval);
          else if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        }, 5000);

        utterance.onend = () => { clearInterval(checkInterval); resolve(); };
        utterance.onerror = (e) => { clearInterval(checkInterval); reject(e); };

        window.speechSynthesis.speak(utterance);
      } catch (err) {
        reject(err);
      }
    });
  }

  pause() {
    if (this._proxy) { this._proxy.pause(); return; }
    window.speechSynthesis.pause();
  }

  resume() {
    if (this._proxy) { this._proxy.resume(); return; }
    window.speechSynthesis.resume();
  }

  stop() {
    if (this._proxy) { this._proxy.stop(); return; }
    window.speechSynthesis.cancel();
  }

  isSpeaking() {
    if (this._proxy) return false; // Can't query chrome.tts speaking state from here
    return window.speechSynthesis.speaking;
  }

  setRate(rate) {
    this.config.rate = rate;
  }
}

if (typeof window !== 'undefined') {
  window.TTSEngine = TTSEngine;
}
