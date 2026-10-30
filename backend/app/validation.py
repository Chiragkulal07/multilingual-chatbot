from pathlib import Path

from app.config import ALLOWED_EXTENSIONS, MAX_FILE_SIZE


def detect_file_type(data: bytes) -> str | None:
    """Identify the real type from the file's first bytes (magic numbers)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"%PDF-"):
        return "pdf"
    return None


def validate_upload(filename: str, data: bytes) -> tuple[str, str]:
    """
    Returns (file_type, extension) or raises ValueError with a user-friendly message.
    """
    ext = Path(filename).suffix.lower()

    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError("Unsupported file type. Allowed: JPG, JPEG, PNG, PDF.")

    if len(data) == 0:
        raise ValueError("File is empty.")

    if len(data) > MAX_FILE_SIZE:
        raise ValueError(f"File exceeds the {MAX_FILE_SIZE // (1024 * 1024)} MB limit.")

    detected = detect_file_type(data)
    if detected is None:
        raise ValueError("File contents are not a valid JPG, PNG, or PDF.")

    expected = {".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".pdf": "pdf"}[ext]
    if detected != expected:
        raise ValueError("File extension does not match the file contents.")

    return detected, ext