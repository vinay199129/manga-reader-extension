# Manga Reader Extension — Agent Working Guidelines

## Golden Rules (Non-Negotiable)

1. **Read before write.** Never modify a file you haven't read. Never guess at existing code structure.
2. **One change at a time.** Make a single logical change, verify it works, then move on. No multi-file rewrites in one shot.
3. **Test after every change.** Load the extension in Chrome, open console, check for errors. If you can't test in browser, at least syntax-check.
4. **Small commits, clear messages.** Each commit = one working change. Never commit broken code.
5. **Follow the spec.** `manga-reader-agent-instructions.md` is the source of truth. Don't deviate without explicit user approval.

## Architecture Rules

- `src/engine/*.js` = **ZERO Chrome APIs.** Pure JS only. These must work in React Native WebView later.
- `src/bridge.js` = ISOLATED world. Only file that touches `chrome.runtime`.
- `src/content.js` = MAIN world. Orchestrates engine. Talks to bridge via `window.postMessage`.
- `src/background.js` = Service worker. Handles image fetch proxy, offscreen doc management, message routing.
- `offscreen/` = Audio + TrOCR inference. Runs in offscreen document.

## Message Flow

```
popup.js → chrome.tabs.sendMessage → bridge.js (ISOLATED)
  → window.postMessage → content.js (MAIN) → engine
engine → window.postMessage → bridge.js → chrome.runtime.sendMessage → background.js
background.js → chrome.runtime.sendMessage → offscreen document (audio/OCR)
```

## Current State (Phase 1 Complete, Phase 2 In Progress)

- Tesseract.js has been REMOVED from `lib/tesseract/`. OCR is shifting to backend manga-ocr (FastAPI) and/or TrOCR offscreen.
- `backend/main.py` exists with FastAPI + manga-ocr server.
- `floating-ui/floating-ui.js` exists as a debug control panel.
- `src/engine/character-registry.js` is new — color-signature-based character tracking.
- `test/test-manga.html` has been deleted.

## Working Pattern for Sessions

1. **Start:** Read this file + `manga-reader-agent-instructions.md` + `MEMORY.md`
2. **Assess:** `git status` + check console errors in Chrome
3. **Plan:** Identify the ONE thing to fix/build next. Write it down.
4. **Execute:** Make the change. Keep it minimal.
5. **Verify:** Load extension, test on mangakakalot.com or manganato.com
6. **Commit:** If it works, commit. If not, fix or revert.

## Common Pitfalls to Avoid

- Don't rewrite entire files when a 5-line edit suffices
- Don't add libraries/dependencies without checking the spec
- Don't add error handling for impossible scenarios
- Don't refactor code that works unless explicitly asked
- Don't create new files when editing existing ones works
- Don't make changes across 10 files in one go — do 1-2 at a time
- Don't spend multiple turns debugging without checking Chrome DevTools console output

## Key Files Quick Reference

| File | Purpose | Lines (approx) |
|------|---------|----------------|
| manifest.json | Extension config | 30 |
| src/background.js | Service worker, image proxy, message routing | ~200 |
| src/bridge.js | ISOLATED world, chrome.runtime relay | ~150 |
| src/content.js | MAIN world, engine orchestrator | ~300 |
| src/engine/manga-engine.js | Core playback loop | ~500 |
| src/engine/ocr.js | OCR processing | ~700 |
| src/engine/panel-detector.js | Panel/bubble detection | ~400 |
| src/engine/tts.js | Text-to-speech wrapper | ~200 |
| src/engine/voice-assigner.js | Voice assignment | ~150 |
| src/engine/site-adapter.js | Site-specific DOM selectors | ~200 |
| src/engine/character-registry.js | Color-based character ID | ~200 |
| src/popup.js | Popup UI logic | ~200 |
| popup/popup.html | Popup markup | ~100 |
| offscreen/offscreen.js | Ambient audio + SFX | ~260 |
| backend/main.py | FastAPI manga-ocr server | ~50 |

## Testing

Primary test site: **mangakakalot.com** (simplest DOM structure)
Secondary: manganato.com, mangadex.org
Edge case: viz.com (strict CSP)
