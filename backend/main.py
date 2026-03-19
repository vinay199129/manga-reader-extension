from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import base64
import time
from io import BytesIO
from PIL import Image, ImageFile
from manga_ocr import MangaOcr

ImageFile.LOAD_TRUNCATED_IMAGES = True

app = FastAPI(title="Manga Reader OCR Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize MangaOCR (downloads model on first run, ~400MB)
print("[manga-ocr] Loading model...")
mocr = MangaOcr()
print("[manga-ocr] Model ready.")

class OCRRequest(BaseModel):
    image_data_url: str  # Base64 data URL from canvas

class OCRResponse(BaseModel):
    text: str

@app.get("/health")
async def health():
    return {"status": "ok", "model": "manga-ocr"}

@app.post("/extract-text", response_model=OCRResponse)
async def extract_text(request: OCRRequest):
    try:
        header, encoded = request.image_data_url.split(",", 1)
        image_data = base64.b64decode(encoded)
        image = Image.open(BytesIO(image_data)).convert('RGB')

        t0 = time.time()
        text = mocr(image)
        ms = int((time.time() - t0) * 1000)
        print(f"[manga-ocr] {ms}ms -> \"{text[:80]}\"")

        return OCRResponse(text=text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

