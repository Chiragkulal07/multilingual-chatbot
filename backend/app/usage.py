import hashlib
import json
from datetime import datetime, timezone

from app.database import get_conn


def _today() -> str:
    return datetime.now().date().isoformat()  # your local date


def calls_today() -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT calls FROM gemini_usage WHERE day = ?", (_today(),)).fetchone()
    return row["calls"] if row else 0


def record_call() -> int:
    day = _today()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO gemini_usage (day, calls) VALUES (?, 1) "
            "ON CONFLICT(day) DO UPDATE SET calls = calls + 1",
            (day,),
        )
        return conn.execute("SELECT calls FROM gemini_usage WHERE day = ?", (day,)).fetchone()["calls"]


def make_cache_key(question: str, chunk_texts: list[str], answer_lang: str, model: str) -> str:
    h = hashlib.sha256()
    for part in (question.strip().lower(), answer_lang, model, *chunk_texts):
        h.update(part.encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def cache_get(key: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT payload FROM answer_cache WHERE cache_key = ?", (key,)).fetchone()
    return json.loads(row["payload"]) if row else None


def cache_put(key: str, payload: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO answer_cache (cache_key, payload, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(payload, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
        )