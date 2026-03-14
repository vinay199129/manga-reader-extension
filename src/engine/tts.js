// src/engine/tts.js — Text-to-speech wrapper (Chrome-agnostic, reusable in mobile)
// Mobile note: On iOS with React Native WebView, window.speechSynthesis is blocked.
// Replace speak() with a postMessage to the native layer using expo-speech. See Phase 5 docs.

/**
 * TTSEngine — wraps Web Speech API for cross-platform TTS.
 */
class TTSEngine {
  /**
   * @param {Object} config
   * @param {number} config.rate - Speech rate (default 1.0)
   * @param {number} config.pitch - Speech pitch (default 1.0)
   * @param {number} config.volume - Speech volume (default 1.0)
   */
  constructor(config = {}) {
    this.config = {
      rate: config.rate ?? 1.0,
      pitch: config.pitch ?? 1.0,
      volume: config.volume ?? 1.0,
    };
    this.voices = [];
  }

  /**
   * Load available voices. Must be called before speak().
   * Handles the async nature of voice loading via voiceschanged event.
   * @returns {Promise<SpeechSynthesisVoice[]>}
   */
  async getVoices() {
    const synth = window.speechSynthesis;
    let voices = synth.getVoices();
    if (voices.length > 0) {
      this.voices = voices;
      return this.voices;
    }
    // Voices not ready yet — wait for voiceschanged event
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
   * Speak the given text. Returns a Promise that resolves when speech is COMPLETE.
   * @param {string} text - Text to speak
   * @param {number} voiceIndex - Index into this.voices array
   * @returns {Promise<void>}
   */
  speak(text, voiceIndex = 0) {
    return new Promise((resolve, reject) => {
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = this.voices[voiceIndex] || null;
        utterance.rate = this.config.rate;
        utterance.pitch = this.config.pitch;
        utterance.volume = this.config.volume;
        utterance.onend = () => resolve();
        utterance.onerror = (e) => reject(e);
        window.speechSynthesis.speak(utterance);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Pause current speech */
  pause() {
    window.speechSynthesis.pause();
  }

  /** Resume paused speech */
  resume() {
    window.speechSynthesis.resume();
  }

  /** Cancel all speech immediately */
  stop() {
    window.speechSynthesis.cancel();
  }

  /** @returns {boolean} Whether speech is currently active */
  isSpeaking() {
    return window.speechSynthesis.speaking;
  }

  /**
   * Update speech rate for subsequent speak() calls.
   * @param {number} rate
   */
  setRate(rate) {
    this.config.rate = rate;
  }
}

// Export for both module and script-tag contexts
if (typeof window !== 'undefined') {
  window.TTSEngine = TTSEngine;
}
