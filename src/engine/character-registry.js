// src/engine/character-registry.js — Tracks character identities via color signatures
// Samples pixels near speech bubbles to build a color profile of the speaking character.
// Maps consistent color signatures to voice indices across panels.

class CharacterRegistry {
  static _dbg(...args) { if (typeof window !== 'undefined' && window.__mangaReaderDebug) console.log('[MangaReader CharReg]', ...args); }

  constructor(config = {}) {
    this._characters = []; // [{signature: Float32Array, voiceIdx, seenCount, dominantHue}]
    this._maxCharacters = config.maxCharacters ?? 6;
    this._nextVoice = 0;
    this._availableVoices = config.availableVoices ?? 2;
    this._hueBuckets = 12; // 30-degree hue buckets
    this._signatureThreshold = config.threshold ?? 0.55;
  }

  /**
   * Given a panel image and a bubble region, sample the "character region"
   * near the bubble and return a consistent voice index for that character.
   *
   * @param {HTMLImageElement|string} panelSource - the panel image
   * @param {{x,y,w,h}} bubbleRegion - bounding box of the speech bubble
   * @returns {Promise<number>} voice index
   */
  async assignVoiceForBubble(panelSource, bubbleRegion) {
    const signature = await this._sampleCharacterRegion(panelSource, bubbleRegion);
    if (!signature) {
      return this._fallbackVoice();
    }

    // Find best matching existing character
    let bestMatch = -1;
    let bestScore = 0;
    for (let i = 0; i < this._characters.length; i++) {
      const score = this._compareSignatures(signature, this._characters[i].signature);
      if (score > this._signatureThreshold && score > bestScore) {
        bestMatch = i;
        bestScore = score;
      }
    }

    if (bestMatch >= 0) {
      this._characters[bestMatch].seenCount++;
      CharacterRegistry._dbg(`Matched character ${bestMatch} (score ${bestScore.toFixed(2)}, voice ${this._characters[bestMatch].voiceIdx})`);
      return this._characters[bestMatch].voiceIdx;
    }

    // New character: assign next available voice
    const voiceIdx = this._nextVoice % this._availableVoices;
    const dominantHue = this._getDominantHue(signature);
    this._characters.push({
      signature,
      voiceIdx,
      seenCount: 1,
      dominantHue,
    });
    this._nextVoice++;
    CharacterRegistry._dbg(`New character ${this._characters.length - 1} (hue ${dominantHue}, voice ${voiceIdx})`);

    // Evict least-seen if over limit
    if (this._characters.length > this._maxCharacters) {
      this._characters.sort((a, b) => b.seenCount - a.seenCount);
      this._characters = this._characters.slice(0, this._maxCharacters);
    }

    return voiceIdx;
  }

  /**
   * Sample the region near/below a speech bubble to get the character's color signature.
   * Returns a hue histogram (12 chromatic buckets + 2 achromatic = 14 total).
   */
  async _sampleCharacterRegion(panelSource, bubbleRegion) {
    try {
      const img = await this._loadImage(panelSource);
      if (!img) return null;

      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (iw === 0 || ih === 0) return null;
      if (!bubbleRegion || bubbleRegion.w === 0) return null;

      // Sample regions around the bubble where the character is likely to be
      const sampleRegions = [];

      // Primary: below the bubble (most common tail direction)
      const belowY = Math.min(bubbleRegion.y + bubbleRegion.h, ih - 1);
      const belowH = Math.min(Math.round(bubbleRegion.h * 0.8), ih - belowY);
      if (belowH > 10) {
        sampleRegions.push({
          x: bubbleRegion.x,
          y: belowY,
          w: bubbleRegion.w,
          h: belowH,
        });
      }

      // Secondary: left of bubble
      const leftX = Math.max(0, bubbleRegion.x - Math.round(bubbleRegion.w * 0.5));
      const leftW = bubbleRegion.x - leftX;
      if (leftW > 10) {
        sampleRegions.push({
          x: leftX,
          y: bubbleRegion.y,
          w: leftW,
          h: bubbleRegion.h,
        });
      }

      // Secondary: right of bubble
      const rightX = bubbleRegion.x + bubbleRegion.w;
      const rightW = Math.min(Math.round(bubbleRegion.w * 0.5), iw - rightX);
      if (rightW > 10) {
        sampleRegions.push({
          x: rightX,
          y: bubbleRegion.y,
          w: rightW,
          h: bubbleRegion.h,
        });
      }

      if (sampleRegions.length === 0) return null;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const combinedHist = new Float32Array(this._hueBuckets + 2);

      for (const region of sampleRegions) {
        canvas.width = region.w;
        canvas.height = region.h;
        ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
        const data = ctx.getImageData(0, 0, region.w, region.h).data;
        this._addToHistogram(data, combinedHist);
      }

      // Normalize
      const total = combinedHist.reduce((a, b) => a + b, 0);
      if (total === 0) return null;
      for (let i = 0; i < combinedHist.length; i++) {
        combinedHist[i] /= total;
      }

      return combinedHist;
    } catch {
      return null;
    }
  }

  _addToHistogram(imageData, hist) {
    for (let i = 0; i < imageData.length; i += 4) {
      const r = imageData[i], g = imageData[i + 1], b = imageData[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const lum = (max + min) / 2;

      // Skip near-white (bubble/page background) and near-black (outlines/borders)
      if (lum > 230 || lum < 25) continue;

      if (delta < 20) {
        // Achromatic pixel
        hist[lum < 128 ? this._hueBuckets : this._hueBuckets + 1] += 1;
      } else {
        // Chromatic: compute hue
        let hue;
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue = ((hue * 60) + 360) % 360;
        const bucket = Math.floor(hue / (360 / this._hueBuckets));
        hist[Math.min(bucket, this._hueBuckets - 1)] += 1;
      }
    }
  }

  /**
   * Compare two signatures using Bhattacharyya coefficient.
   * Returns 0 (no overlap) to 1 (identical distributions).
   */
  _compareSignatures(a, b) {
    let bc = 0;
    for (let i = 0; i < a.length; i++) {
      bc += Math.sqrt(a[i] * b[i]);
    }
    return bc;
  }

  /** Get the dominant hue bucket (0-360 degrees) from a signature */
  _getDominantHue(signature) {
    let maxVal = 0;
    let maxIdx = 0;
    for (let i = 0; i < this._hueBuckets; i++) {
      if (signature[i] > maxVal) {
        maxVal = signature[i];
        maxIdx = i;
      }
    }
    return Math.round(maxIdx * (360 / this._hueBuckets));
  }

  _fallbackVoice() {
    const v = this._nextVoice % this._availableVoices;
    this._nextVoice++;
    return v;
  }

  _loadImage(source) {
    return new Promise((resolve) => {
      if (source instanceof HTMLImageElement) {
        if (source.complete && source.naturalWidth > 0) return resolve(source);
        source.onload = () => resolve(source);
        source.onerror = () => resolve(null);
        return;
      }
      if (typeof source === 'string') {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = source;
        return;
      }
      resolve(null);
    });
  }

  reset() {
    this._characters = [];
    this._nextVoice = 0;
  }
}

if (typeof window !== 'undefined') {
  window.CharacterRegistry = CharacterRegistry;
}
