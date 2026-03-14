// src/engine/voice-assigner.js — Assigns voices to characters/speech bubbles
// Phase 4 upgrade: replace with ML face classifier that detects character gender/identity
// from nearby face crops, maps characters to consistent voice IDs, and persists the mapping
// across panels in the same chapter.

/**
 * VoiceAssigner — determines which voice index to use for each speech bubble.
 */
class VoiceAssigner {
  /**
   * @param {Object} config
   * @param {string} config.strategy - 'single' (Phase 1), 'position' (Phase 3), or 'alternating'
   */
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy ?? 'single',
    };
    this._alternateState = 0;
  }

  /**
   * Assign a voice index for a given bubble element.
   * @param {HTMLElement} bubbleElement - The speech bubble DOM element
   * @param {number} availableVoicesCount - Number of available TTS voices
   * @returns {number} Voice index (0 or 1)
   */
  assignVoice(bubbleElement, availableVoicesCount) {
    if (this.config.strategy === 'single' || availableVoicesCount <= 1) {
      return 0;
    }

    if (this.config.strategy === 'position') {
      return this._positionStrategy(bubbleElement);
    }

    // Fallback: alternating strategy
    return this._alternatingStrategy();
  }

  /**
   * Position strategy: left half of viewport → voice 0, right half → voice 1.
   * @param {HTMLElement} element
   * @returns {number}
   */
  _positionStrategy(element) {
    try {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const viewportCenter = window.innerWidth / 2;
      return centerX < viewportCenter ? 0 : 1;
    } catch {
      return this._alternatingStrategy();
    }
  }

  /**
   * Alternating strategy: toggles between 0 and 1 on each call.
   * @returns {number}
   */
  _alternatingStrategy() {
    const voice = this._alternateState;
    this._alternateState = this._alternateState === 0 ? 1 : 0;
    return voice;
  }

  /** Reset alternating state (e.g., at start of new chapter) */
  reset() {
    this._alternateState = 0;
  }
}

// Export for both module and script-tag contexts
if (typeof window !== 'undefined') {
  window.VoiceAssigner = VoiceAssigner;
}
