import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env", override=True)

UPLOAD_DIR = BASE_DIR / "storage" / "uploads"
DB_PATH = BASE_DIR / "storage" / "metadata.db"
FAISS_INDEX_PATH = BASE_DIR / "storage" / "faiss.index"

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB per file
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".pdf"}
CORS_ORIGINS = ["http://localhost:5173"]

# Chunking
CHUNK_SIZE_TOKENS = 400
CHUNK_OVERLAP_TOKENS = 60

# Gemini
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "")  # leave empty: a fallback costs extra requests
GEMINI_DAILY_LIMIT = int(os.getenv("GEMINI_DAILY_LIMIT", "15"))
GEMINI_TIMEOUT_MS = 45_000
GEMINI_MAX_OUTPUT_TOKENS = 2048

# Embeddings: cloud APIs, no local model. The first provider is primary, the other is the fallback.
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "gemini").strip().lower()
EMBEDDING_MODELS = {
    "gemini": os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001"),
    "openai": os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
}
if EMBEDDING_PROVIDER not in EMBEDDING_MODELS:
    raise ValueError("EMBEDDING_PROVIDER must be 'gemini' or 'openai'")
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "768"))
EMBEDDING_BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "50"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
_API_KEYS = {"gemini": GEMINI_API_KEY, "openai": OPENAI_API_KEY}
_order = [EMBEDDING_PROVIDER] + [p for p in EMBEDDING_MODELS if p != EMBEDDING_PROVIDER]
EMBEDDING_PROVIDERS = [p for p in _order if _API_KEYS[p]] or [EMBEDDING_PROVIDER]  # only providers with a key


def embedding_id(provider: str) -> str:
    return f"{provider}:{EMBEDDING_MODELS[provider]}:{EMBEDDING_DIM}"


# LLM fallback (used when Gemini fails or the daily Gemini cap is reached)
OPENAI_LLM_MODEL = os.getenv("OPENAI_LLM_MODEL", "gpt-4o-mini")  # set empty to disable the fallback
OPENAI_MAX_OUTPUT_TOKENS = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "2048"))
OPENAI_LLM_ENABLED = bool(OPENAI_API_KEY and OPENAI_LLM_MODEL)

# Retrieval and answering (retune after switching embedding models, see Debug search)
TOP_K = 5
MAX_QUESTION_CHARS = 1000
MIN_RELEVANCE_SCORE = 0.30
CONTEXT_SCORE_FLOOR = 0.25

# Each embedding provider has its own score range, so each gets its own thresholds
SCORE_THRESHOLDS = {
    p: {
        "min": float(os.getenv(f"{p.upper()}_MIN_RELEVANCE_SCORE", MIN_RELEVANCE_SCORE)),
        "floor": float(os.getenv(f"{p.upper()}_CONTEXT_SCORE_FLOOR", CONTEXT_SCORE_FLOOR)),
    }
    for p in EMBEDDING_MODELS
}