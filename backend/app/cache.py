"""Language-aware caching for answers and embeddings.

Two layers, both stored in SQLite so they survive restarts:

1. Answer cache — skips the LLM call when the same question is asked against the same
   context in the same answer language.
2. Embedding cache — skips the embedding API for questions and chunks seen before
   (re-uploads, reprocessing, repeated questions).

Keys are built from *normalized* text so visually identical English / Hindi / Kannada
input maps to one entry even when the Unicode underneath differs (NFC vs NFD, zero-width
joiners, Devanagari/Kannada digits, danda vs full stop, case, spacing, trailing "?").
"""

import hashlib
import json
import logging
import random
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import numpy as np

from app.config import (
    ANSWER_CACHE_MAX_ENTRIES,
    ANSWER_CACHE_TTL_DAYS,
    EMBEDDING_CACHE_MAX_ENTRIES,
    EMBEDDING_DIM,
    embedding_id,
)
from app.database import get_conn
from app.languages import script_counts

logger = logging.getLogger("cache")

KEY_VERSION = "v2"  # bump to invalidate every cached answer at once
PRUNE_PROBABILITY = 0.02  # prune roughly every 50 writes


# ---------------------------------------------------------------------------
# Language-aware normalization
# ---------------------------------------------------------------------------
# Invisible characters that change bytes but not meaning (ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen)
_INVISIBLE = dict.fromkeys(map(ord, "​‌‍⁠﻿­"), None)

_DIGITS = {}
for _base in (0x0966, 0x0CE6):  # Devanagari ०-९, Kannada ೦-೯
    for _i in range(10):
        _DIGITS[_base + _i] = str(_i)

_PUNCT_MAP = {
    ord("।"): ".",  # । danda
    ord("॥"): ".",  # ॥ double danda
    ord("‘"): "'", ord("’"): "'",
    ord("“"): '"', ord("”"): '"',
    ord("–"): "-", ord("—"): "-",
    ord("？"): "?", ord("؟"): "?",  # full-width / Arabic question marks
}

_TRAILING = re.compile(r"[\s.?!,;:'\"\-]+$")
_LEADING = re.compile(r"^[\s.?!,;:'\"\-]+")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([.?!,;:])")
_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Canonical form of a question for cache lookups. Never shown to users or sent to models."""
    t = unicodedata.normalize("NFC", text or "")
    t = t.translate(_INVISIBLE).translate(_DIGITS).translate(_PUNCT_MAP)
    t = t.casefold()  # no-op for Kannada/Devanagari, folds Latin case
    t = _WS.sub(" ", t)
    t = _SPACE_BEFORE_PUNCT.sub(r"\1", t)
    t = _TRAILING.sub("", t)
    t = _LEADING.sub("", t)
    return t.strip()


def answer_matches_language(answer: str, lang: str) -> bool:
    """True if the answer is mostly written in the requested language's script.

    Answers may legitimately mix in English terms, names and numbers, so the bar is loose.
    A Kannada request answered in English (or vice versa) is not cached, so a bad
    answer never gets locked in."""
    c = script_counts(answer or "")
    letters = c["kn"] + c["hi"] + c["en"] + c["other"]
    if letters < 8:
        return True  # too short to judge (numbers, single words)
    if lang in ("kn", "hi"):
        return c[lang] / letters >= 0.35
    # English: reject only if it is dominated by an Indic script
    return (c["kn"] + c["hi"]) / letters < 0.5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _sha(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Answer cache
# ---------------------------------------------------------------------------
def answer_key(question: str, answer_lang: str, model_tag: str, chunk_texts: list[str] | None = None) -> str:
    """Same normalized question + same answer language + same context => same key.

    `answer_lang` is the *resolved* language (never "auto"), so an "auto" Kannada
    question and an explicit Kannada request share one entry."""
    return _sha(KEY_VERSION, model_tag, answer_lang, normalize_text(question), *(chunk_texts or []))


def get_answer(key: str) -> dict | None:
    now = _now().isoformat()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT payload, expires_at FROM answer_cache WHERE cache_key = ?", (key,)
        ).fetchone()
        if not row:
            return None
        if not row["expires_at"] or row["expires_at"] < now:
            conn.execute("DELETE FROM answer_cache WHERE cache_key = ?", (key,))
            return None
        conn.execute(
            "UPDATE answer_cache SET hits = hits + 1, last_used = ? WHERE cache_key = ?", (now, key)
        )
    return json.loads(row["payload"])


def put_answer(key: str, payload: dict, kind: str, answer_lang: str) -> bool:
    """Store an answer. `kind` picks the TTL: 'document', 'general' or 'refusal'.
    Returns False when the answer was judged unfit to cache."""
    if not answer_matches_language(payload.get("answer", ""), answer_lang):
        logger.info("Not caching answer: it is not in the requested language (%s).", answer_lang)
        return False

    ttl_days = ANSWER_CACHE_TTL_DAYS.get(kind, 1)
    now = _now()
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO answer_cache "
            "(cache_key, payload, created_at, expires_at, last_used, hits, kind, language) "
            "VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            (
                key,
                json.dumps(payload, ensure_ascii=False),
                now.isoformat(),
                (now + timedelta(days=ttl_days)).isoformat(),
                now.isoformat(),
                kind,
                answer_lang,
            ),
        )
    if random.random() < PRUNE_PROBABILITY:
        prune()
    return True


# ---------------------------------------------------------------------------
# Embedding cache
# ---------------------------------------------------------------------------
def _embedding_key(provider: str, task_type: str, text: str) -> str:
    # Queries are normalized so trivially different phrasings reuse a vector;
    # document chunks are keyed on their exact text.
    keyed = normalize_text(text) if task_type == "RETRIEVAL_QUERY" else text
    return _sha(embedding_id(provider), task_type, keyed)


def get_embeddings(provider: str, task_type: str, texts: list[str]) -> dict[int, np.ndarray]:
    """Cached vectors for `texts`, as {index: vector}. Missing texts are simply absent."""
    if not texts:
        return {}
    keys = [_embedding_key(provider, task_type, t) for t in texts]
    found: dict[str, bytes] = {}
    with get_conn() as conn:
        for i in range(0, len(keys), 500):  # stay under SQLite's variable limit
            batch = keys[i : i + 500]
            rows = conn.execute(
                f"SELECT cache_key, vector FROM embedding_cache WHERE cache_key IN ({','.join('?' * len(batch))})",
                batch,
            ).fetchall()
            found.update({r["cache_key"]: r["vector"] for r in rows})
        if found:
            now = _now().isoformat()
            conn.executemany(
                "UPDATE embedding_cache SET hits = hits + 1, last_used = ? WHERE cache_key = ?",
                [(now, k) for k in found],
            )

    out: dict[int, np.ndarray] = {}
    for i, k in enumerate(keys):
        blob = found.get(k)
        if blob is not None:
            vec = np.frombuffer(blob, dtype="float32")
            if vec.shape[0] == EMBEDDING_DIM:
                out[i] = vec
    return out


def put_embeddings(provider: str, task_type: str, texts: list[str], vectors: np.ndarray) -> None:
    if not texts:
        return
    now = _now().isoformat()
    rows = [
        (_embedding_key(provider, task_type, t), np.asarray(v, dtype="float32").tobytes(), provider, task_type, now, now)
        for t, v in zip(texts, vectors)
    ]
    with get_conn() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO embedding_cache "
            "(cache_key, vector, provider, task_type, created_at, last_used, hits) "
            "VALUES (?, ?, ?, ?, ?, ?, 0)",
            rows,
        )
    if random.random() < PRUNE_PROBABILITY:
        prune()


# ---------------------------------------------------------------------------
# Maintenance
# ---------------------------------------------------------------------------
def _trim(conn, table: str, max_entries: int) -> int:
    count = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
    excess = count - max_entries
    if excess <= 0:
        return 0
    conn.execute(
        f"DELETE FROM {table} WHERE cache_key IN "
        f"(SELECT cache_key FROM {table} ORDER BY last_used ASC LIMIT ?)",
        (excess,),
    )
    return excess


def prune() -> dict:
    """Drop expired answers, then least-recently-used entries above the size caps."""
    now = _now().isoformat()
    with get_conn() as conn:
        expired = conn.execute(
            "DELETE FROM answer_cache WHERE expires_at IS NULL OR expires_at < ?", (now,)
        ).rowcount
        answers_trimmed = _trim(conn, "answer_cache", ANSWER_CACHE_MAX_ENTRIES)
        embeddings_trimmed = _trim(conn, "embedding_cache", EMBEDDING_CACHE_MAX_ENTRIES)
    return {"expired": expired, "answers_trimmed": answers_trimmed, "embeddings_trimmed": embeddings_trimmed}


def stats() -> dict:
    with get_conn() as conn:
        by_lang = conn.execute(
            "SELECT language, kind, COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits "
            "FROM answer_cache GROUP BY language, kind ORDER BY language, kind"
        ).fetchall()
        emb = conn.execute(
            "SELECT provider, task_type, COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits "
            "FROM embedding_cache GROUP BY provider, task_type"
        ).fetchall()
    return {
        "answers": [dict(r) for r in by_lang],
        "embeddings": [dict(r) for r in emb],
    }


def clear(scope: str = "all") -> dict:
    with get_conn() as conn:
        answers = conn.execute("DELETE FROM answer_cache").rowcount if scope in ("all", "answers") else 0
        embeddings = conn.execute("DELETE FROM embedding_cache").rowcount if scope in ("all", "embeddings") else 0
    return {"answers_cleared": answers, "embeddings_cleared": embeddings}
