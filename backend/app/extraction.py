import os
import re
from pathlib import Path

# Skip PaddleOCR's slow "check model hosters" connectivity test at startup
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import numpy as np
import pymupdf  # PyMuPDF

from app.languages import PADDLE_LANG, detect_text_language, looks_garbled, script_fraction

MIN_PDF_TEXT_CHARS = 20   # fewer characters than this on a page => treat as scanned
AUTO_ACCEPT_CONF = 0.85   # English OCR at least this confident => no need to try other languages

_engines: dict = {}


def get_ocr(lang: str):
    """One PaddleOCR engine per language, loaded on first use (models download once)."""
    if lang not in _engines:
        from paddleocr import PaddleOCR

        _engines[lang] = PaddleOCR(
            lang=PADDLE_LANG[lang],
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    return _engines[lang]


def normalize_text(text: str) -> str:
    """Tidy whitespace while keeping line breaks as paragraph hints."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def run_ocr(image, lang: str) -> tuple[str, float | None]:
    """OCR one image (path or BGR array) with the given language model."""
    lines, scores = [], []
    for res in get_ocr(lang).predict(image):
        lines.extend(res["rec_texts"])
        scores.extend(res["rec_scores"])
    if not lines:
        return "", None
    return normalize_text("\n".join(lines)), round(float(sum(scores) / len(scores)), 4)


def _score(text: str, conf: float | None, lang: str) -> float:
    """Confidence, discounted when the text isn't written in the model's own script."""
    if not text or conf is None:
        return 0.0
    return conf * script_fraction(text, lang)


def auto_ocr(image) -> tuple[str, float | None, str]:
    """
    Pick the language automatically. Clean English is accepted after one OCR run.
    Otherwise try Kannada and Hindi too and keep the best-scoring result.
    """
    text, conf = run_ocr(image, "en")
    if text and conf is not None and conf >= AUTO_ACCEPT_CONF and script_fraction(text, "en") >= 0.8:
        return text, conf, "en"

    best = (_score(text, conf, "en"), text, conf, "en")
    for lang in ("kn", "hi"):
        t, c = run_ocr(image, lang)
        s = _score(t, c, lang)
        if s > best[0]:
            best = (s, t, c, lang)
    return best[1], best[2], best[3]


def extract_image(path: Path, language: str) -> list[dict]:
    if language == "auto":
        text, conf, used = auto_ocr(str(path))
    else:
        used = language
        text, conf = run_ocr(str(path), language)
    return [
        {
            "page_number": 1,
            "text": text,
            "method": "ocr",
            "confidence": conf,
            "language": detect_text_language(text, used),
        }
    ]


def extract_pdf(path: Path, language: str) -> list[dict]:
    pages = []
    ocr_lang = None if language == "auto" else language  # auto: decided on the first scanned page

    with pymupdf.open(path) as doc:
        for index, page in enumerate(doc, start=1):
            embedded = normalize_text(page.get_text("text"))

            # Use the PDF's own text only if it exists and isn't broken-font junk
            if len(embedded) >= MIN_PDF_TEXT_CHARS and not looks_garbled(embedded):
                pages.append(
                    {
                        "page_number": index,
                        "text": embedded,
                        "method": "pdf_text",
                        "confidence": None,
                        "language": detect_text_language(embedded),
                    }
                )
                continue

            dpi = 200 if ocr_lang == "en" else 250  # Indic scripts need more resolution
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
            img = np.ascontiguousarray(img[:, :, ::-1])  # RGB -> BGR for PaddleOCR

            if ocr_lang is None:
                text, conf, ocr_lang = auto_ocr(img)
            else:
                text, conf = run_ocr(img, ocr_lang)

            pages.append(
                {
                    "page_number": index,
                    "text": text,
                    "method": "ocr",
                    "confidence": conf,
                    "language": detect_text_language(text, ocr_lang),
                }
            )
    return pages


def extract_file(path: Path, file_type: str, language: str = "auto") -> list[dict]:
    """file_type is 'jpeg', 'png' or 'pdf'. language is 'auto', 'en', 'hi' or 'kn'."""
    if file_type == "pdf":
        return extract_pdf(path, language)
    return extract_image(path, language)