# Manga Reader Extension — Roadmap & Task List

## M0: Stabilize (Bug Fixes)
- [ ] Fix `offscreen.html` — remove `trocr.js` script tag (file doesn't exist, causes 404)
- [ ] Fix `manga-engine.js:1444` — `setVoiceB()` sets strategy `'position'` but checks expect `'character'`
- [ ] Fix `manga-engine.js:1349` — `this.ocr._cropRegion()` doesn't exist, gutter OCR crashes silently
- [ ] Fix stale Tesseract comments in `content.js:103` and `manga-engine.js:135`
- [ ] Commit stable baseline

## M1: Agent Testing (Selenium Smoke Test)
- [ ] `pip install selenium`
- [ ] Create `test/smoke_test.py` — loads extension, navigates to mangakakalot, captures console errors + screenshot
- [ ] Verify test runs and passes on clean codebase

## M2: Backend manga-ocr as Primary OCR
- [ ] Harden `backend/main.py` — health check endpoint, error handling, CORS
- [ ] Update `ocr.js` — make backend manga-ocr the default path (not Tesseract)
- [ ] Add fallback: if backend is down, show clear error in popup instead of silent failure
- [ ] Test: Play on mangakakalot → OCR extracts real text via backend

## M3: Real Bubble Detection (ONNX)
- [ ] Download `ogkalu/comic-text-and-bubble-detector` ONNX model (~42.9M params)
- [ ] Create `offscreen/bubble-detector.js` — ONNX inference in offscreen doc
- [ ] Replace stub `extractBubbles()` in `ocr.js` with real bubble regions
- [ ] Wire bubble regions → `voice-assigner.js` → character voices actually work
- [ ] Test: Play on mangakakalot → different bubbles get different voices

## M4: In-Browser OCR Fallback (PaddleOCR ONNX)
- [ ] Bundle PaddleOCR ONNX models (detection ~4.7MB + recognition ~7.6MB English)
- [ ] Create `offscreen/paddle-ocr.js` — ONNX inference for text recognition
- [ ] Add OCR strategy selector: backend (best) → PaddleOCR (offline) → error
- [ ] Test: Kill backend server → OCR still works via PaddleOCR in-browser

## M5: SFX Filtering
- [ ] Add text classifier to filter sound effects ("BOOM", "CRASH") from narration
- [ ] Either rule-based (uppercase short words, known SFX patterns) or small ML model
- [ ] Test: Panels with SFX text don't get narrated as dialogue

## Competitive Edge (Our Unique Features)
| Feature | Us | MangaVoice | AI Manga Reader |
|---------|-----|------------|-----------------|
| Works on any manga site | Yes | Yes (macOS only) | No (standalone app) |
| Character voice assignment | Yes | No | No |
| Cinematic effects + ambient audio | Yes | No | No |
| No local server required | M4 goal | No (Flask) | Yes |
| Cross-platform | Yes | macOS only | Yes |
