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
    return ratio > 0.03 if indic else ratio > 0.25


MESSAGES = {
    "not_enough_info": {
        "en": "I couldn't find that information in the uploaded document.",
        "hi": "मुझे अपलोड किए गए दस्तावेज़ में यह जानकारी नहीं मिली।",
        "kn": "ಅಪ್ಲೋಡ್ ಮಾಡಿದ ದಾಖಲೆಯಲ್ಲಿ ಈ ಮಾಹಿತಿ ನನಗೆ ಕಂಡುಬಂದಿಲ್ಲ.",
    },
    "greeting_doc": {
        "en": "Hello! I'm ready to help you with your document. What would you like to know?",
        "hi": "नमस्ते! मैं आपके दस्तावेज़ में आपकी सहायता के लिए तैयार हूँ। आप क्या जानना चाहते हैं?",
        "kn": "ನಮಸ್ಕಾರ! ನಿಮ್ಮ ದಾಖಲೆಯ ಕುರಿತು ಸಹಾಯ ಮಾಡಲು ನಾನು ಸಿದ್ಧನಾಗಿದ್ದೇನೆ. ನೀವು ಏನನ್ನು ತಿಳಿಯಲು ಬಯಸುತ್ತೀರಿ?",
    },
    "no_documents": {
        "en": "No document is currently attached. You can ask any general question or attach a file to analyze it.",
        "hi": "वर्तमान में कोई दस्तावेज़ संलग्न नहीं है। आप कोई भी सामान्य प्रश्न पूछ सकते हैं या उसका विश्लेषण करने के लिए एक फ़ाइल संलग्न कर सकते हैं।",
        "kn": "ಪ್ರಸ್ತುತ ಯಾವುದೇ ದಾಖಲೆಯನ್ನು ಲಗತ್ತಿಸಲಾಗಿಲ್ಲ. ನೀವು ಯಾವುದೇ ಸಾಮಾನ್ಯ ಪ್ರಶ್ನೆಯನ್ನು ಕೇಳಬಹುದು ಅಥವಾ ಅದನ್ನು ವಿಶ್ಲೇಷಿಸಲು ಫೈಲ್ ಲಗತ್ತಿಸಬಹುದು.",
    },
    "daily_limit": {
        "en": "Daily request limit reached. Please try again tomorrow.",
        "hi": "दैनिक अनुरोध सीमा समाप्त हो गई है। कृपया कल पुनः प्रयास करें।",
        "kn": "ದೈನಂದಿನ ಮಿತಿ ಮೀರಿದೆ. ದಯವಿಟ್ಟು ನಾಳೆ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    },
}


def message(key: str, lang: str) -> str:
    msg_dict = MESSAGES.get(key, MESSAGES["not_enough_info"])
    return msg_dict.get(lang) or msg_dict.get("en") or ""
