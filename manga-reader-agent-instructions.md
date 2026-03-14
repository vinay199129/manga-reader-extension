# Manga Reader — Chrome Extension
## Complete Project Specification & Agent Build Instructions

---

## HOW TO USE THIS DOCUMENT (READ FIRST)

This document is the single source of truth for building the Manga Reader Chrome Extension. It contains the full product idea, all architecture decisions, the complete tech stack, the folder structure, and detailed per-file build instructions across all phases.

**When using this with an AI agent (GitHub Copilot Agent Mode / Claude):**
- Give the agent this entire document at the start of a session
- Tell the agent which phase you are working on
- The agent should follow the file specifications exactly
- Every architecture decision in this document is intentional — do not deviate without a reason
- If the agent asks a question not answered here, default to: simplest working solution, no external APIs, no backend

---

## 1. PRODUCT OVERVIEW

### What it is
A Chrome browser extension that transforms reading manga online into a cinematic, narrated experience. When a user visits any manga website and clicks Play, the extension automatically:
1. Detects all manga panels on the page
2. Scrolls to each panel with cinematic animation
3. Extracts text from speech bubbles using OCR
4. Narrates the dialogue using different voices for different characters
5. Moves to the next panel automatically, synced to the audio

### Why it is valuable
Manga readers currently have a passive, manual experience. This extension makes manga feel like an animated audiobook — a new format between reading and watching anime.

### Target audience
Public release — any manga fan using Chrome. Must work at zero cost per user.

### Future evolution
After the Chrome extension is proven, the same engine will be wrapped in a React Native mobile app (iOS + Android) with a built-in WebView browser. Approximately 75% of the JS code written for the extension will be reused directly in the mobile app. Every architecture decision must account for this future reuse.

---

## 2. CORE ARCHITECTURE DECISIONS

These decisions are final. Do not change them without explicit instruction.

| Decision | Choice | Reason |
|----------|--------|--------|
| Product type | Chrome Extension (Manifest V3) | Full browser = years of work. Extension = weeks. 95% same power. |
| Mobile path | React Native + WebView | Reuses extension JS engine directly via injectedJavaScript |
| Cost strategy | $0 — all processing in user's browser | Each user's browser is their own compute. Scales to 100k users free. |
| Animation library | GSAP (free tier) | Industry standard, works inside injected scripts, no cost |
| Panel detection Phase 1 | CSS/DOM heuristics (large img tags) | No ML needed for MVP, fast to build |
| Panel detection Phase 2+ | ONNX.js + pretrained model in browser | No backend, no cost, model downloaded once and cached |
| OCR Phase 1 | Tesseract.js (bundled locally in extension) | Free, no backend, works immediately |
| OCR Phase 2+ | manga-ocr on Hugging Face Spaces (free tier API) | Better accuracy on Japanese/stylised text |
| TTS Phase 1-3 | Web Speech API (built into Chrome) | Free, built-in, multiple voices, no API key needed |
| TTS Phase 4+ | ElevenLabs (user provides own API key) | Premium quality, user pays, not the developer |
| Voice assignment Phase 1 | Single narrator voice | Simplest possible MVP — voice assigner module present but defaults to voiceIndex 0 |
| Voice assignment Phase 3 | Bubble position heuristics (left = Voice A, right = Voice B) | No ML, surprisingly effective |
| Voice assignment Phase 4 | Face classifier ONNX model in browser | Consistent character voices, hardest problem, deferred |
| Content script world | MAIN world with ISOLATED bridge script | Engine + libraries run in page's MAIN world for full DOM/API access; a thin bridge script in ISOLATED world handles all chrome.* messaging |
| Infrastructure | No backend for Phases 1–4 | $0 forever, no server to maintain |

---

## 3. TECH STACK

### Extension core
- **Language:** Vanilla JavaScript (ES6 modules)
- **Manifest:** Version 3 (MV3) — Chrome's current standard
- **No build tools for Phase 1** — plain JS files, no webpack/vite/bundler needed
- **Phase 2+:** Add esbuild for bundling when ONNX.js is introduced

### Libraries (all free, bundled locally in extension)
| Library | Version | Purpose | Loaded via |
|---------|---------|---------|-----------|
| GSAP | 3.x free | Panel animations, scroll, zoom, shake | Bundled locally in `lib/gsap.min.js` |
| Tesseract.js | 4.x | OCR text extraction from images | Bundled locally in `lib/tesseract/` (includes worker + WASM + eng.traineddata) |
| ONNX.js (onnxruntime-web) | 1.17.x | Run ML models in browser for panel detection | Bundled (Phase 2) |

### Mobile (Phase 5, not built yet — architecture only)
- React Native + Expo
- react-native-webview
- expo-speech (for iOS TTS bridge)
- All engine JS files (manga-engine.js, ocr.js, tts.js) reused directly

---

## 4. COMPLETE FOLDER STRUCTURE

```
manga-reader-extension/
│
├── manifest.json                  # Chrome extension configuration (MV3)
├── README.md                      # Project documentation
│
├── popup/
│   └── popup.html                 # Extension popup UI (play/pause/settings)
│
├── icons/
│   ├── icon16.png                 # Extension icon 16x16 (generate: solid #e94560 square with white ▶)
│   ├── icon48.png                 # Extension icon 48x48
│   └── icon128.png                # Extension icon 128x128
│
├── lib/                           # Locally bundled third-party libraries
│   ├── gsap.min.js                # GSAP 3.12.x — download from cdnjs
│   └── tesseract/                 # Tesseract.js 4.x local bundle
│       ├── tesseract.min.js       # Core library
│       ├── worker.min.js          # Web Worker script
│       ├── tesseract-core-simd.wasm.js  # WASM loader
│       └── eng.traineddata.gz     # English language data (~4MB compressed)
│
├── src/
│   │
│   ├── content.js                 # Injected into MAIN world — loads engine + libraries
│   ├── bridge.js                  # Injected into ISOLATED world — chrome.runtime messaging bridge
│   ├── popup.js                   # Controls popup UI behaviour
│   ├── background.js              # MV3 service worker (messaging + image fetch proxy)
│   │
│   └── engine/                    # Shared engine — reused in mobile app later
│       ├── manga-engine.js        # Core orchestration logic
│       ├── panel-detector.js      # Finds manga panels on page (Phase 1: heuristics, Phase 2: ONNX)
│       ├── ocr.js                 # Text extraction from speech bubbles
│       ├── tts.js                 # Text-to-speech wrapper
│       └── voice-assigner.js      # Assigns voices to characters/bubbles
│
└── models/                        # ML models (Phase 2 — not needed for Phase 1)
    └── panel-detector.onnx        # Pretrained panel detection model (~8MB)
```

### Critical architectural rule — the engine folder
The `src/engine/` folder must contain ZERO Chrome-specific APIs (`chrome.*`). It must be pure JS that works in any environment — browser page, Chrome extension, or React Native WebView. All Chrome extension APIs (`chrome.runtime`, `chrome.storage`, etc.) live only in `bridge.js`, `popup.js`, and `background.js`. This is what enables the ~75% mobile code reuse.

### Icon generation (Phase 1)
Create simple placeholder icons: a solid `#e94560` (manga red) rounded square with a white play triangle (▶) centered. Generate at 16×16, 48×48, and 128×128 pixels. Use any image editor, online favicon generator, or a simple canvas script. The extension will not load without these files.

---

## 5. FILE-BY-FILE SPECIFICATIONS

### 5.1 manifest.json

**Purpose:** Chrome extension configuration

**Requirements:**
- Manifest version 3 (NOT version 2)
- Extension name: "Manga Reader"
- Version: "0.1.0"
- Description: "Cinematic, narrated manga reading experience"
- Permissions needed: `activeTab`, `scripting`, `storage`
- Host permissions: `<all_urls>` (must work on any manga website)
- Popup action pointing to `popup/popup.html`
- Background service worker pointing to `src/background.js`
- Icons: 16, 48, 128 sizes from `icons/` folder
- Content Security Policy: allow `wasm-unsafe-eval` (required for Tesseract.js and ONNX.js WebAssembly)
- Do NOT declare content_scripts in manifest — scripts are injected programmatically via the scripting API

**Web accessible resources (critical for MAIN world script loading):**
```json
"web_accessible_resources": [{
  "resources": [
    "src/engine/*.js",
    "src/content.js",
    "lib/*",
    "lib/tesseract/*"
  ],
  "matches": ["<all_urls>"]
}]
```

**CSP requirement (critical for WASM libraries):**
```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

**Permission note:** The `<all_urls>` host permission triggers a prominent Chrome install warning ("Read and change all your data on all websites"). This is acceptable for development. For Chrome Web Store release, consider switching to `activeTab` + `chrome.permissions.request()` on demand to reduce friction for new users.

---

### 5.2 src/background.js

**Purpose:** MV3 service worker — handles extension lifecycle, tab messaging, and cross-origin image proxying

**Requirements:**
- Listen for the extension action (toolbar icon) click — inject bridge.js (ISOLATED world) and content.js (MAIN world) into the active tab if not already injected
- Relay messages between popup and content script when needed
- Keep it minimal — MV3 service workers terminate when idle, so no state storage here
- Use `chrome.scripting.executeScript` to inject scripts
- Use `chrome.storage.session` for temporary state (NOT global variables — they reset)

**Key behaviour:**
```
User clicks extension icon
  → background.js checks if scripts are already injected (via chrome.storage.session flag)
  → If not:
      1. Inject bridge.js into active tab (world: 'ISOLATED') — handles chrome.runtime messaging
      2. Inject content.js into active tab (world: 'MAIN') — loads engine + libraries
  → If yes: do nothing (content.js handles everything from popup messages)
```

**Script injection code pattern:**
```javascript
// Inject bridge first (ISOLATED world — has chrome.runtime access)
await chrome.scripting.executeScript({
  target: { tabId },
  files: ['src/bridge.js'],
  world: 'ISOLATED'
});

// Then inject content script (MAIN world — has DOM + library access)
await chrome.scripting.executeScript({
  target: { tabId },
  files: ['src/content.js'],
  world: 'MAIN'
});
```

**Cross-origin image fetch proxy (critical for OCR):**
Manga images are served from CDN domains. Drawing cross-origin images to a canvas makes it "tainted" — Tesseract.js cannot read pixel data. The background service worker has `<all_urls>` host permissions and can fetch any URL.

```javascript
// Listen for image fetch requests from bridge.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'fetchImage') {
    fetch(msg.url)
      .then(r => r.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ dataUrl: reader.result });
        reader.readAsDataURL(blob);
      })
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep message channel open for async response
  }
});
```

**Important MV3 warning for the agent:** Do NOT use `chrome.browserAction` — that is MV2. Use `chrome.action` for MV3. Do NOT store state in global variables — the service worker sleeps and wakes, resetting all globals. Use `chrome.storage.session` instead.

---

### 5.2b src/bridge.js

**Purpose:** Thin messaging bridge running in the content script ISOLATED world. Relays messages between chrome.runtime (popup/background) and the engine running in the MAIN world (via window.postMessage).

**Requirements:**
- Runs in ISOLATED world — has full access to `chrome.runtime` APIs
- Does NOT import any engine modules — it is purely a message relay
- Listens for `chrome.runtime.onMessage` from popup/background and forwards commands to MAIN world via `window.postMessage`
- Listens for `window.addEventListener('message')` from MAIN world engine and forwards status updates to popup via `chrome.runtime.sendMessage`
- Handles `fetchImage` requests from MAIN world: receives image URL via postMessage, calls `chrome.runtime.sendMessage({ action: 'fetchImage', url })` to background.js, returns the data URL back to MAIN world via postMessage
- All postMessages must use a unique `source: 'manga-reader'` field to avoid conflicts with page scripts
- Guard against double-injection: `if (window.__mangaReaderBridgeInit) return;`

**Message flow:**
```
Popup → chrome.runtime → bridge.js (ISOLATED) → window.postMessage → content.js (MAIN) → engine
Engine → content.js (MAIN) → window.postMessage → bridge.js (ISOLATED) → chrome.runtime → Popup

OCR image fetch:
Engine needs image → content.js posts {action:'fetchImage', url} → bridge.js → chrome.runtime.sendMessage → background.js fetches → returns dataUrl → bridge.js → postMessage → content.js → engine
```

---

### 5.3 src/engine/tts.js

**Purpose:** Text-to-speech wrapper — Chrome-agnostic, reusable in mobile

**Requirements:**
- Export a `TTSEngine` class (NOT a singleton — allows multiple instances)
- Constructor accepts config: `{ rate: 1.0, pitch: 1.0, volume: 1.0 }`
- `async getVoices()` — returns array of available SpeechSynthesisVoice objects. Must handle the async nature of voice loading (voices may not be ready immediately — use the `voiceschanged` event with a Promise wrapper). Store result in `this.voices` for later use.
- `async speak(text, voiceIndex = 0)` — speaks the given text using the voice at voiceIndex. Returns a Promise that resolves when speech is COMPLETE (not just started). This is critical for the engine to know when to move to the next panel.
- `pause()` — pauses current speech
- `resume()` — resumes paused speech
- `stop()` — cancels all speech immediately
- `isSpeaking()` — returns boolean
- `setRate(rate)` — updates `this.config.rate` for subsequent `speak()` calls
- All methods must use `window.speechSynthesis` (no Chrome APIs)
- Add a comment at the top: "Mobile note: On iOS with React Native WebView, window.speechSynthesis is blocked. Replace speak() with a postMessage to the native layer using expo-speech. See Phase 5 docs."

**The speak() Promise pattern (important — get this right):**
```javascript
speak(text, voiceIndex = 0) {
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = this.voices[voiceIndex] || null;
    utterance.rate = this.config.rate;
    utterance.pitch = this.config.pitch;
    utterance.volume = this.config.volume;
    utterance.onend = () => resolve();
    utterance.onerror = (e) => reject(e);
    window.speechSynthesis.speak(utterance);
  });
}
```

---

### 5.4 src/engine/ocr.js

**Purpose:** Text extraction from manga speech bubbles using Tesseract.js

**Requirements:**
- Export an `OCREngine` class
- Constructor accepts config: `{ language: 'eng', workerPath: null, corePath: null, langPath: null }`
- `async initialize()` — creates and configures the Tesseract worker. Must be called once before `extractText`. Should show no UI — silent initialisation.
- `async extractText(imageSource)` — takes a DOM `<img>` element OR a data URL string (for cross-origin proxied images), returns extracted text as a string. Returns empty string on failure (never throw).
- `async extractTextFromRegion(imageSource, { x, y, width, height })` — extracts text from a specific region of an image (for when panel bounding boxes are known)
- `destroy()` — terminates the Tesseract worker to free memory
- Assumes `window.Tesseract` is available (loaded by content.js from local bundle before this script runs)
- No Chrome APIs anywhere in this file
- Add a comment: "Phase 2 upgrade path: replace Tesseract.js with manga-ocr API hosted on Hugging Face Spaces (free tier) for significantly better accuracy on Japanese/stylised manga text."

**Cross-origin image handling (critical):**
Manga images are typically served from CDN domains different from the manga page. Drawing these to a canvas makes it "tainted" and blocks `getImageData()`. The engine itself does NOT handle cross-origin fetching (no Chrome APIs allowed). Instead:
- `content.js` provides a `fetchImageAsDataUrl(url)` function to the engine at initialization.
- This function requests the image data URL via the bridge → background.js proxy.
- `extractText()` should accept both `<img>` elements and data URL strings. When given an `<img>` element, first try direct canvas drawing. If it fails with a SecurityError, call `this.fetchImageFn(img.src)` to get a data URL, then retry.

```javascript
// Set by content.js during engine initialization
setImageFetcher(fn) {
  this.fetchImageFn = fn;
}
```

**Tesseract.js worker configuration (critical for MV3):**
Tesseract.js spawns Web Workers and loads WASM files. In an MV3 extension, workers must reference extension-local URLs. CDN loading will fail from the content script context. Configure paths to bundled local files:

```javascript
const worker = await Tesseract.createWorker('eng', 1, {
  workerPath: this.config.workerPath,   // e.g., resolved extension URL for 'lib/tesseract/worker.min.js'
  corePath: this.config.corePath,       // e.g., resolved extension URL for 'lib/tesseract/tesseract-core-simd.wasm.js'
  langPath: this.config.langPath,       // e.g., resolved extension URL for 'lib/tesseract/'
});
```

Note: Extension URLs are resolved in `content.js` (via the bridge), NOT in `ocr.js`. The resolved URLs are passed as config to the OCREngine constructor so the engine stays Chrome-API-free.

**Error handling rule:** Never let OCR errors crash the engine. Wrap all Tesseract calls in try/catch and return `''` on any error. A panel with no text is fine — the engine skips TTS for that panel.

---

### 5.5 src/engine/voice-assigner.js

**Purpose:** Decides which voice index to assign to each speech bubble

**Requirements:**
- Export a `VoiceAssigner` class
- Constructor accepts config: `{ strategy: 'single' }` — Phase 1 uses `single` strategy (always returns 0). Phase 3 switches to `position`.
- `assignVoice(bubbleElement, availableVoicesCount)` — takes a DOM element (speech bubble) and returns a voice index
- **Single strategy** (Phase 1): always return `0`. Simplest MVP — one narrator voice.
- **Position strategy** (Phase 3): examine the bubble's `getBoundingClientRect()`. If the bubble's horizontal center is in the left half of the viewport, return 0. If right half, return 1. This approximates "left character = voice A, right character = voice B".
- **Alternating strategy** (fallback): simply alternates between 0 and 1 on each call. Use this when position strategy cannot determine position.
- Add a comment: "Phase 4 upgrade: replace with ML face classifier that detects character gender/identity from nearby face crops, maps characters to consistent voice IDs, and persists the mapping across panels in the same chapter."

---

### 5.6 src/engine/panel-detector.js

**Purpose:** Finds manga panels on a web page in the correct reading order

**Requirements:**
- Export a `PanelDetector` class
- Constructor accepts config: `{ strategy: 'heuristic', minWidth: 300, minHeight: 200, readingDirection: 'ltr' }`
- `detect()` — scans the current page DOM and returns an array of `{ element, boundingBox, index }` objects representing manga panels in reading order. Returns a Promise.
- **Reading direction:** If `readingDirection` is `'ltr'`, sort panels top-to-bottom then left-to-right. If `'rtl'`, sort top-to-bottom then right-to-left. Default `'ltr'` for English-translated manga on listed test sites. Phase 2+: auto-detect direction from site metadata or user toggle.
- **Heuristic strategy (Phase 1):** Find all `<img>` elements on the page. Filter to those wider than `minWidth` AND taller than `minHeight`. Sort by reading direction. Return them as the panel array. This is simple and works on 80% of manga sites.
- Filter out UI images: skip any image whose `src` contains common non-manga patterns (`icon`, `logo`, `avatar`, `banner`, `ad`, `button`, `thumb`, `nav`)
- Filter out images that are not visible: skip any image with `display: none` or `visibility: hidden` or zero dimensions
- `getSpeechBubbles(panelElement)` — for a given panel image, attempts to find speech bubble regions. Phase 1: return a single region covering the full image (we OCR the whole panel). Phase 2+: use ONNX model to find precise bubble bounding boxes.
- Add a comment block: "Phase 2 upgrade: replace heuristic detect() with ONNX.js model inference. Load panel-detector.onnx using onnxruntime-web. The model returns bounding boxes for panels AND speech bubbles separately, enabling precise per-bubble OCR and voice assignment."

**Lazy-loaded image handling (critical for manga sites):**
Most manga sites lazy-load images as the user scrolls — only images near the viewport have real `src` values. `detect()` called at page load will miss panels below the fold.

Strategy:
1. On `detect()`, first scroll the page to the bottom (programmatically and quickly) to trigger all lazy-load handlers, then scroll back to top.
2. After the pre-scroll, wait 2 seconds for images to load.
3. Set up a `MutationObserver` watching for new `<img>` elements or `src` attribute changes. Store the observer in `this.observer`.
4. `detect()` can be called multiple times — `play()` in manga-engine.js should re-run detection before starting playback to catch any newly loaded images.
5. `destroy()` — disconnects the MutationObserver.

```javascript
async waitForImages() {
  // Scroll to bottom to trigger lazy loaders
  const originalScroll = window.scrollY;
  window.scrollTo(0, document.body.scrollHeight);
  await this.sleep(1500);
  window.scrollTo(0, originalScroll);
  await this.sleep(500);
}
```

---

### 5.7 src/engine/manga-engine.js

**Purpose:** Core orchestration — coordinates all engine modules into a single playback experience

**Requirements:**
- Export a `MangaEngine` class
- Constructor accepts config:
  ```javascript
  {
    voiceIndex: 0,          // default narrator voice
    scrollDelay: 800,       // ms to wait after scrolling before reading
    panelDelay: 500,        // ms to wait between panels
    zoomEnabled: true,      // whether to zoom into each panel
    autoDetectVoices: true, // whether to use voice assigner or single voice
    readingDirection: 'ltr' // 'ltr' or 'rtl' — passed to panel detector
  }
  ```
- `async initialize()` — initialises all sub-engines (OCREngine, TTSEngine, PanelDetector, VoiceAssigner). Must be called before `play()`.
- `async play()` — starts or resumes playback. Sets `this.isPlaying = true`. Re-runs panel detection (to catch lazy-loaded images). Loops through all detected panels. For each panel: scroll to it → wait scrollDelay → zoom into it → extract text → speak text → wait panelDelay → restore panel → move to next.
- `pause()` — pauses playback and TTS. Sets `this.isPaused = true`.
- `resume()` — resumes from paused state.
- `stop()` — stops everything, restores all modified panels to original state, resets to panel 0.
- `jumpToPanel(index)` — jumps to a specific panel index.
- `setSpeed(rate)` — updates TTS speech rate via `this.tts.setRate(rate)`. Called by content.js when popup sends `setSpeed` action.
- `getStatus()` — returns `{ isPlaying, isPaused, currentPanel, totalPanels, currentText }`
- Must emit custom DOM events for status updates: `mangareader:status` — so content.js can relay status to popup without the engine knowing about Chrome APIs.
- Import all engine modules using relative paths: `./tts.js`, `./ocr.js`, `./panel-detector.js`, `./voice-assigner.js`
- NO Chrome APIs anywhere in this file

**The panel playback loop (implement exactly like this):**
```javascript
async play() {
  this.isPlaying = true;
  this.isPaused = false;

  // Re-detect panels to catch any lazy-loaded images
  this.panels = await this.panelDetector.detect();

  for (let i = this.currentPanel; i < this.panels.length; i++) {
    if (!this.isPlaying) break;
    while (this.isPaused) {
      await this.sleep(100); // poll every 100ms while paused
    }

    this.currentPanel = i;
    const panel = this.panels[i];

    // Cache original styles before any modification
    this.cacheOriginalStyle(panel.element);

    await this.scrollToPanel(panel.element);
    await this.sleep(this.config.scrollDelay);
    await this.zoomToPanel(panel.element);

    const text = await this.ocr.extractText(panel.element);
    this.currentText = text;
    if (text.trim()) {
      const voiceCount = this.voices ? this.voices.length : 1;
      const voiceIdx = this.voiceAssigner.assignVoice(panel.element, voiceCount);
      await this.tts.speak(text, voiceIdx); // await full speech completion
    }

    // Restore panel to original style after reading
    this.restoreOriginalStyle(panel.element);
    await this.sleep(this.config.panelDelay);
    this.emitStatus();
  }

  this.isPlaying = false;
  this.emitStatus();
}
```

**DOM state caching and restoration (critical — constraint #7):**
The extension must not permanently alter the manga page. All style changes (zoom transforms, opacity, etc.) must be reversible.

```javascript
// Store original inline styles before modifying any panel
cacheOriginalStyle(element) {
  if (!this._originalStyles) this._originalStyles = new Map();
  if (!this._originalStyles.has(element)) {
    this._originalStyles.set(element, element.getAttribute('style') || '');
  }
}

// Restore a single panel's original style
restoreOriginalStyle(element) {
  if (this._originalStyles && this._originalStyles.has(element)) {
    const original = this._originalStyles.get(element);
    if (original) {
      element.setAttribute('style', original);
    } else {
      element.removeAttribute('style');
    }
  }
}

// Restore ALL modified panels — called by stop()
restoreAllStyles() {
  if (this._originalStyles) {
    this._originalStyles.forEach((style, el) => {
      if (style) {
        el.setAttribute('style', style);
      } else {
        el.removeAttribute('style');
      }
    });
    this._originalStyles.clear();
  }
}
```

**The scrollToPanel and zoomToPanel methods:**
- `scrollToPanel(element)` — uses `element.scrollIntoView({ behavior: 'smooth', block: 'center' })`. Returns a promise that resolves after a fixed delay (allows scroll animation to complete).
- `zoomToPanel(element)` — if `zoomEnabled`, applies a CSS transform to the element: scale up to fill more of the viewport, then scale back down after speech completes. Use GSAP if available (`window.gsap`), otherwise use CSS transitions directly. GSAP is loaded by content.js from the local bundle.

**Cleanup:**
- `stop()` must call `this.restoreAllStyles()`, `this.tts.stop()`, and `this.panelDetector.destroy()` (disconnects MutationObserver).
- `destroy()` — full teardown: calls `stop()`, then `this.ocr.destroy()` to free Tesseract worker memory.

---

### 5.8 src/content.js

**Purpose:** Entry point injected into manga web pages in the MAIN world. Loads engine and libraries. Communicates with the extension via bridge.js postMessage relay.

**Execution world:** MAIN (set by background.js during injection). This means:
- ✅ Full access to page DOM, `window.*`, and all loaded libraries
- ✅ Can use `window.Tesseract`, `window.gsap` after loading them
- ❌ No access to `chrome.runtime` or any `chrome.*` APIs — all extension communication goes through `window.postMessage` ↔ `bridge.js`

**Requirements:**
- Check if already initialised (guard against double-injection): `if (window.__mangaReaderInitialised) return; window.__mangaReaderInitialised = true;`
- Load required library scripts from local extension bundle (NOT CDN). The base URL is set by background.js before content.js loads: `window.__mangaReaderExtURL = '<extension-base-url>'`
- Load GSAP: inject `<script src="${extURL}/lib/gsap.min.js">`
- Load Tesseract.js: inject `<script src="${extURL}/lib/tesseract/tesseract.min.js">`
- Load engine modules as classic scripts in dependency order (tts → ocr → voice-assigner → panel-detector → manga-engine)
- Create a single MangaEngine instance
- Call `engine.initialize()`, passing cross-origin image fetcher and Tesseract config paths
- Listen for commands from bridge.js via `window.addEventListener('message')`:
  - `{ source: 'manga-reader', action: 'play' }` → `engine.play()`
  - `{ source: 'manga-reader', action: 'pause' }` → `engine.pause()`
  - `{ source: 'manga-reader', action: 'resume' }` → `engine.resume()`
  - `{ source: 'manga-reader', action: 'stop' }` → `engine.stop()`
  - `{ source: 'manga-reader', action: 'status' }` → post `engine.getStatus()` back
  - `{ source: 'manga-reader', action: 'setVoice', voiceIndex: N }` → update engine voice config
  - `{ source: 'manga-reader', action: 'setSpeed', rate: N }` → `engine.setSpeed(rate)`
- Listen for `mangareader:status` events from the engine and forward them to bridge.js via `window.postMessage({ source: 'manga-reader', type: 'status', data: ... })`
- Provide `fetchImageAsDataUrl(url)` function to the engine — sends postMessage to bridge, waits for response with data URL
- Handle library loading errors gracefully — if Tesseract fails to load, the engine continues without OCR (silent, no crash)

**Script loading helper (local bundle):**
```javascript
function loadLocalScript(path) {
  return new Promise((resolve, reject) => {
    const fullUrl = window.__mangaReaderExtURL + '/' + path;
    if (document.querySelector(`script[src="${fullUrl}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = fullUrl;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
```

**Image fetch helper (for cross-origin OCR):**
```javascript
function fetchImageAsDataUrl(url) {
  return new Promise((resolve) => {
    const requestId = 'img_' + Date.now() + '_' + Math.random();
    function handler(event) {
      if (event.data?.source === 'manga-reader' && event.data?.type === 'fetchImageResponse' && event.data?.requestId === requestId) {
        window.removeEventListener('message', handler);
        resolve(event.data.dataUrl || null);
      }
    }
    window.addEventListener('message', handler);
    window.postMessage({ source: 'manga-reader', action: 'fetchImage', url, requestId }, '*');
  });
}
```

---

### 5.9 src/popup.js

**Purpose:** Controls the popup UI, communicates with content.js

**Requirements:**
- On popup load: query the active tab and send `{ action: 'status' }` to get current state
- Populate voice dropdown: send `{ action: 'status' }` and use Web Speech API voices directly in popup context (`window.speechSynthesis.getVoices()`)
- Play button click: send `{ action: 'play' }` to active tab content script
- Pause button click: send `{ action: 'pause' }`
- Stop button click: send `{ action: 'stop' }`
- Voice dropdown change: send `{ action: 'setVoice', voiceIndex: selectedIndex }`
- Speed slider change: send `{ action: 'setSpeed', rate: sliderValue }`
- Listen for status updates from content script: update the status line, update panel counter, update play/pause button state
- All `chrome.tabs.sendMessage` calls must be wrapped in try/catch — the content script may not be injected yet

**Error and empty state handling:**
- If content script is not yet injected (sendMessage fails): show "Click the extension icon on a manga page to start"
- If `status` response shows `totalPanels === 0`: show "No manga panels detected on this page"
- If `getVoices()` returns empty: show "Loading voices..." and retry after `voiceschanged` event
- If play is clicked but status comes back with an error: show "Something went wrong — check the page console (F12)"

---

### 5.10 popup/popup.html

**Purpose:** The visual UI shown when user clicks the extension icon

**Design requirements:**
- Width: 300px fixed
- Clean, minimal dark-themed design (manga readers often use dark mode)
- Background: #1a1a2e (dark navy)
- Accent colour: #e94560 (manga red)
- Font: system-ui, sans-serif

**UI elements (in order, top to bottom):**
1. Header: extension logo/icon + "Manga Reader" title
2. Status bar: shows "Ready", "Playing panel X / Y", "Paused", "Stopped", "No panels detected", "Injecting..."
3. Current text display: small scrollable area showing the text being read (max 3 lines, overflow hidden)
4. Control buttons row: Play ▶, Pause ⏸, Stop ⏹ — icon buttons, horizontally centred
5. Voice selector: label "Narrator voice" + `<select>` dropdown populated by popup.js
6. Speed slider: label "Speed" + range input (min 0.5, max 2.0, step 0.1, default 1.0) + value display
7. Footer: small text "Works on any manga site"

**No frameworks, no external CSS** — all styles inline or in a `<style>` block in the HTML file. Reference `src/popup.js` with `<script src="../src/popup.js">`.

---

## 6. PHASE BUILD PLAN

### Phase 1 — MVP (Build this first)
**Goal:** A working extension. User opens a manga chapter, clicks Play, manga auto-scrolls panel by panel and reads aloud with one narrator voice.

**Files to build:**
- manifest.json
- src/background.js
- src/bridge.js
- src/engine/tts.js
- src/engine/ocr.js (Tesseract.js version)
- src/engine/voice-assigner.js (single strategy — always voice 0)
- src/engine/panel-detector.js (heuristic version with lazy-load handling)
- src/engine/manga-engine.js
- src/content.js
- src/popup.js
- popup/popup.html
- icons/icon16.png, icon48.png, icon128.png (placeholder icons)

**Setup steps before coding:**
1. Create `manga-reader-extension/` folder with structure from Section 4
2. Download GSAP 3.12.x minified → `lib/gsap.min.js`
3. Download Tesseract.js 4.x local bundle (worker, WASM, eng.traineddata) → `lib/tesseract/`
4. Generate placeholder icon PNGs (see Section 4 icon generation)

**Definition of done:** Extension loads on mangakakalot.com or manganato.com. Click Play. Extension scrolls through panels, reads text aloud. No crashes. Stop restores the page to its original state.

---

### Phase 2 — Panel Detection + Cinematic Animations
**Goal:** Extension knows exact panel boundaries. Zooms into each panel cinematically. Feels like a moving storyboard.

**Changes from Phase 1:**
- `panel-detector.js`: add ONNX model inference strategy using onnxruntime-web
- `manga-engine.js`: enhance `zoomToPanel()` with GSAP timeline animations (Ken Burns effect, shake for action panels)
- `manifest.json`: add `models/` as a web accessible resource
- Add esbuild bundling (ONNX.js is too large for simple CDN injection)
- Download and bundle `panel-detector.onnx` model file

**Key challenge:** Loading ONNX.js in a MV3 extension requires using the Offscreen Documents API (service workers can't run WASM directly). Create `src/offscreen.html` + `src/offscreen.js` as the WASM execution context.

**Timeline:** 1–2 months

---

### Phase 3 — Dual Voice Narration
**Goal:** Two distinct voices. Left side of page = Voice A, right side = Voice B. Conversations feel like two characters speaking.

**Changes from Phase 2:**
- `voice-assigner.js`: switch strategy from `single` to `position`, refine with viewport percentage zones
- `popup.html` / `popup.js`: add second voice selector ("Character B voice")
- `manga-engine.js`: pass both voice configs to voice assigner

**Timeline:** 2–4 weeks on top of Phase 2

---

### Phase 4 — Smart Character Voices
**Goal:** Each character gets a consistent voice. Extension identifies character faces and assigns permanent voice identities per chapter.

**Changes from Phase 3:**
- Add face detection ONNX model (MobileNet-based, ~5MB)
- `voice-assigner.js`: add ML character identification strategy
- Add character voice mapping stored in `chrome.storage.local` (persists across sessions)
- Optional: allow user to bring their own ElevenLabs API key for premium voices

**This is the hardest phase.** Defer until Phase 1–3 are stable and have real users.

---

### Phase 5 — Mobile App (React Native + WebView)
**Goal:** Standalone iOS + Android app with built-in manga browser. Effects apply automatically on any manga site.

**What gets reused from the extension:**
- `src/engine/tts.js` — unchanged (iOS needs native bridge, see note in file)
- `src/engine/ocr.js` — unchanged
- `src/engine/voice-assigner.js` — unchanged
- `src/engine/panel-detector.js` — unchanged
- `src/engine/manga-engine.js` — unchanged

**New code for mobile only:**
- React Native app shell with navigation
- WebView component wrapping the manga browser
- `injectedJavaScript` prop passes content.js code into WebView
- iOS TTS bridge: WebView postMessage → React Native `expo-speech` (approximately 50 lines)
- Android: Web Speech API works natively in WebView, no bridge needed
- App Store + Play Store setup

---

## 7. PROBLEM AREAS AND KNOWN CHALLENGES

| Problem | Severity | Phase | Solution |
|---------|----------|-------|----------|
| MV3 content script cannot use ES6 imports directly | High | 1 | Use `web_accessible_resources` + load scripts in dependency order in MAIN world |
| CDN scripts load in page world, not content script isolated world | High | 1 | Use MAIN world for engine execution + ISOLATED world bridge for chrome.* APIs |
| Cross-origin images block canvas pixel access for OCR | High | 1 | Background.js fetch proxy returns data URLs to engine via bridge relay |
| Tesseract.js worker/WASM fails in content script context | High | 1 | Bundle Tesseract.js locally in `lib/tesseract/`; configure workerPath, corePath, langPath |
| MV3 service worker cannot run WASM | High | 2 | Use Offscreen Documents API for ONNX inference |
| Service worker state resets when idle | Medium | 1 | Use `chrome.storage.session` not global variables |
| Tesseract.js accuracy on manga text | Medium | 1 | Accept for MVP, upgrade to manga-ocr on HF Spaces in Phase 2 |
| Web Speech API voices load asynchronously | Low | 1 | Use `voiceschanged` event with Promise, not synchronous call |
| iOS WKWebView blocks Web Speech API | Medium | 5 | expo-speech bridge via postMessage |
| Same script injected twice if user reloads | Low | 1 | Guard with `window.__mangaReaderInitialised` and `window.__mangaReaderBridgeInit` flags |
| Character identity detection accuracy | Very High | 4 | Deferred to Phase 4, use heuristics until then |
| Different manga sites use different HTML structures | Medium | 1-2 | Heuristic detector handles most cases; add site-specific adapters in Phase 2+ |
| Manga images lazy-load below the fold | Medium | 1 | Pre-scroll page to trigger lazy loaders + MutationObserver for late-arriving images |
| RTL manga reading direction | Medium | 1 | Config toggle `readingDirection: 'ltr'\|'rtl'`; default LTR; Phase 2 auto-detect |
| Stop must restore page to original state | Medium | 1 | Cache original inline styles in Map before transforms; restoreAllStyles() on stop |
| Popup shows no feedback if content script not injected | Low | 1 | Add error/empty states: "No panels detected", "Injecting...", "Click icon on manga page" |
| No cleanup of Tesseract worker on page navigation | Low | 1 | Call `ocr.destroy()` in engine's `destroy()` method; hook into `beforeunload` event |
| `<all_urls>` permission triggers scary install warning | Low | 1 | Use for dev; switch to `activeTab` + on-demand permission for Chrome Web Store release |

---

## 8. CONSTRAINTS — NEVER VIOLATE THESE

1. **No backend server** — all processing must happen in the user's browser. Zero server-side ML inference.
2. **No paid APIs** — no OpenAI, no Google Cloud Vision, no Azure. Users may optionally provide their own ElevenLabs key in Phase 4, but the core product is always free.
3. **No Chrome APIs in engine files** — `src/engine/*.js` must be pure JavaScript, no `chrome.*` calls. This is required for mobile reuse.
4. **No build tools for Phase 1** — keep it simple. Plain JS files, no webpack, no bundler.
5. **No frameworks in popup** — plain HTML + CSS + JS only. No React, no Vue.
6. **Must work on all manga sites** — no site-specific code in Phase 1. Heuristic detection must be general.
7. **Extension must not break the manga page** — all DOM modifications must be reversible. Stop button must restore the page to original state by restoring cached inline styles.

---

## 9. TESTING SITES

Use these real manga sites to test the extension during development:

| Site | URL | Notes |
|------|-----|-------|
| MangaKakalot | mangakakalot.com | Good panel structure, English translated manga |
| MangaNato | manganato.com | Same network as Kakalot, slightly different structure |
| MangaDex | mangadex.org | Most popular, complex layout — good stress test |
| Viz Media | viz.com/shonenjump | Official site, stricter CSP — test for edge cases |

Start testing on MangaKakalot first — it has the simplest, most consistent panel structure.

---

## 10. HOW TO LOAD AND TEST THE EXTENSION IN CHROME

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top right corner
3. Click **Load unpacked**
4. Select the `manga-reader-extension` root folder
5. The extension icon appears in the toolbar
6. Go to any manga chapter page
7. Click the extension icon → click Play
8. Open **DevTools** (F12) → **Console** tab to see debug logs and errors

**After making code changes:**
1. Go to `chrome://extensions`
2. Click the refresh icon on the Manga Reader card
3. Refresh the manga page
4. Test again

---

## 11. AGENT INSTRUCTIONS (FOR GHCP AGENT MODE)

When you receive this document as context, follow these rules:

**Starting a session:**
- Read sections 1–4 fully before writing any code
- Confirm which phase is being built before starting
- Ask for clarification only if a requirement is genuinely ambiguous — do not ask for things already specified in this document

**Writing code:**
- Follow the specifications in Section 5 exactly
- Every file must include a comment at the top with the file path and a one-line description
- Every class must include JSDoc comments on public methods
- Use `async/await` — not `.then()` chains
- Use `const` and `let` — never `var`
- Handle all errors with try/catch — never let unhandled Promise rejections crash the engine
- When a Phase 2+ feature is referenced, add a clearly marked comment showing where to plug it in

**File creation order for Phase 1 (do in this order):**
1. manifest.json
2. Download and place `lib/gsap.min.js` and `lib/tesseract/*` files
3. Generate placeholder icons into `icons/`
4. src/engine/tts.js
5. src/engine/ocr.js
6. src/engine/voice-assigner.js
7. src/engine/panel-detector.js
8. src/engine/manga-engine.js
9. src/bridge.js
10. src/content.js
11. src/background.js
12. popup/popup.html
13. src/popup.js

**When something is not specified:**
- Default to the simplest working solution
- Default to no external APIs
- Default to no backend
- Default to pure JS, no frameworks

**Do not:**
- Add libraries not listed in Section 3
- Add Chrome permissions not listed in Section 5.1
- Create backend endpoints or API calls
- Use `manifest_version: 2`
- Use global variables in background.js
- Add Chrome APIs inside any file in `src/engine/`
- Load Tesseract.js or GSAP from CDN — use bundled local files in `lib/`

---

*Document version: 1.1 — Phase 1 build ready, gap fixes applied*
*Last updated: March 2026*
*Changes in v1.1: Added MAIN/ISOLATED world split architecture, local library bundling, cross-origin image proxy, lazy-load handling, DOM restoration, RTL reading direction, icon generation instructions, popup error states, expanded known challenges table, fixed spec inconsistencies (availableVoices, setSpeed handler, Phase 1 voice strategy, web_accessible_resources)*
*Next update: When Phase 2 begins (add ONNX model specs and offscreen document details)*
