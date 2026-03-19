// src/engine/voice-assigner.js — Assigns voices to characters/speech bubbles
// Supports strategies: 'single', 'position', 'alternating', 'character' (color-signature based)

/**
 * VoiceAssigner — determines which voice index to use for each speech bubble.
 */
class VoiceAssigner {
  /**
   * @param {Object} config
   * @param {string} config.strategy - 'single', 'position', 'alternating', or 'character'
   */
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy ?? 'single',
    };
    this._alternateState = 0;
    this._characterRegistry = null;
  }

  /**
   * Wire in a CharacterRegistry for the 'character' strategy.
   * @param {CharacterRegistry} registry
   */
  setCharacterRegistry(registry) {
    this._characterRegistry = registry;
  }

  /**
   * Assign a voice index for a given bubble element (legacy per-panel method).
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
   * Assign a voice for a specific speech bubble using the character registry.
   * Falls back to legacy strategies if character matching fails.
   *
   * @param {HTMLImageElement|string} panelSource - The panel image
   * @param {{x,y,w,h}} bubbleRegion - Bounding box of the speech bubble within the panel
   * @param {number} availableVoicesCount
   * @returns {Promise<number>} Voice index
   */
  async assignVoiceForBubble(panelSource, bubbleRegion, availableVoicesCount) {
    if (this.config.strategy === 'character' && this._characterRegistry) {
      try {
        return await this._characterRegistry.assignVoiceForBubble(panelSource, bubbleRegion);
      } catch {
        // Fall through to legacy
      }
    }
    // Fallback
    return this._alternatingStrategy();
  }

  /**
   * Position strategy: left half of viewport → voice 0, right half → voice 1.
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
