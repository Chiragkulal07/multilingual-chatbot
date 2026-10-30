"""Language helpers: script detection, garbled-text detection, translated messages.
Everything here runs locally, so it costs no Gemini requests."""

LANGUAGES = {"en": "English", "hi": "Hindi", "kn": "Kannada"}
OCR_CHOICES = {"auto", "en", "hi", "kn"}
PADDLE_LANG = {"en": "en", "hi": "hi", "kn": "ka"}  # PaddleOCR calls Kannada "ka"

KN_RANGE = (0x0C80, 0x0CFF)
HI_RANGE = (0x0900, 0x097F)


def _is_kn(c: str) -> bool:
    return KN_RANGE[0] <= ord(c) <= KN_RANGE[1]


def _is_hi(c: str) -> bool:
    return HI_RANGE[0] <= ord(c) <= HI_RANGE[1]


def _is_latin(c: str) -> bool:
    return c.isascii() and c.isalpha()


def script_counts(text: str) -> dict:
    kn = sum(1 for c in text if _is_kn(c))
    hi = sum(1 for c in text if _is_hi(c))
    en = sum(1 for c in text if _is_latin(c))
    other = sum(1 for c in text if c.isalpha() and not (_is_kn(c) or _is_hi(c) or _is_latin(c)))
    return {"kn": kn, "hi": hi, "en": en, "other": other}


def detect_text_language(text: str, default: str = "en") -> str:
    """Dominant script of the text: 'kn', 'hi' or 'en'."""
    counts = script_counts(text)
    if counts["kn"] + counts["hi"] + counts["en"] == 0:
        return default
    return max(("kn", "hi", "en"), key=lambda k: counts[k])


def script_fraction(text: str, lang: str) -> float:
    """Share of the text's letters written in the script of `lang`."""
    c = script_counts(text)
    total = c["kn"] + c["hi"] + c["en"] + c["other"]
    return c[lang] / total if total else 0.0


def looks_garbled(text: str) -> bool:
    """
    Many Indic PDFs use broken or legacy font encodings, so the embedded text comes
    out as junk like 'ĭೖಸೂರು ದಸº'. Real English/Hindi/Kannada text almost never contains
    letters from the Latin-1 supplement / Latin Extended / IPA blocks, so a noticeable
    share of them means the text layer can't be trusted and we should OCR instead.
    """
    chars = [c for c in text if not c.isspace()]
    if len(chars) < 10:
        return False
    foreign = sum(
        1 for c in chars
        if 0x00C0 <= ord(c) <= 0x02AF or ord(c) == 0xFFFD or 0xE000 <= ord(c) <= 0xF8FF
    )
    indic = sum(1 for c in chars if _is_kn(c) or _is_hi(c))
    ratio = foreign / len(chars)
    # Mixed with real Indic text, a few stray symbols are already suspicious.
    # With no Indic text (fully Latin-1 junk), require a larger share.
    return ratio > 0.03 if indic else ratio > 0.25


MESSAGES = {
    "not_enough_info": {
        "en": "The uploaded documents do not contain enough information to answer this question.",
        "hi": "अपलोड किए गए दस्तावेज़ों में इस प्रश्न का उत्तर देने के लिए पर्याप्त जानकारी नहीं है।",
        "kn": "ಅಪ್ಲೋಡ್ ಮಾಡಿದ ದಾಖಲೆಗಳಲ್ಲಿ ಈ ಪ್ರಶ್ನೆಗೆ ಉತ್ತರಿಸಲು ಸಾಕಷ್ಟು ಮಾಹಿತಿ ಇಲ್ಲ.",
    },
    "no_documents": {
        "en": "There are no processed documents to search yet. Upload a file and wait until it is ready.",
        "hi": "अभी तक कोई दस्तावेज़ प्रोसेस नहीं हुआ है। कोई फ़ाइल अपलोड करें और उसके तैयार होने तक प्रतीक्षा करें।",
        "kn": "ಇನ್ನೂ ಯಾವುದೇ ದಾಖಲೆ ಪ್ರಕ್ರಿಯೆಗೊಂಡಿಲ್ಲ. ಫೈಲ್ ಅಪ್ಲೋಡ್ ಮಾಡಿ ಮತ್ತು ಅದು ಸಿದ್ಧವಾಗುವವರೆಗೆ ಕಾಯಿರಿ.",
    },
    "daily_limit": {
        "en": "This app's daily AI request limit has been reached. Showing the most relevant passages instead.",
        "hi": "इस ऐप की दैनिक AI अनुरोध सीमा पूरी हो गई है। इसके बजाय सबसे प्रासंगिक अंश दिखाए जा रहे हैं।",
        "kn": "ಈ ಆ್ಯಪ್‌ನ ದೈನಂದಿನ AI ವಿನಂತಿ ಮಿತಿ ತಲುಪಿದೆ. ಬದಲಿಗೆ ಅತ್ಯಂತ ಸಂಬಂಧಿತ ಭಾಗಗಳನ್ನು ತೋರಿಸಲಾಗುತ್ತಿದೆ.",
    },
}


def message(key: str, lang: str) -> str:
    return MESSAGES[key].get(lang) or MESSAGES[key]["en"]