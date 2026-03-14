# Manga Reader — Chrome Extension

Cinematic, narrated manga reading experience. Visit any manga website, click Play, and the extension auto-scrolls through panels while reading dialogue aloud.

## Quick Start

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select this folder
4. Navigate to any manga chapter page (try mangakakalot.com)
5. Click the Manga Reader icon → Play

## Architecture

- **MAIN world** (`content.js` + `src/engine/*`) — runs in the page context with full DOM access
- **ISOLATED world** (`bridge.js`) — relays messages between chrome.runtime and the MAIN world engine
- **Service worker** (`background.js`) — handles injection, image proxying, and lifecycle

All engine files (`src/engine/`) are Chrome-API-free for future React Native mobile reuse.

## Phase 1 (Current)

- Heuristic panel detection (large `<img>` tags)
- Tesseract.js OCR (bundled locally)
- Web Speech API TTS (single narrator voice)
- GSAP zoom animations

## License

MIT
