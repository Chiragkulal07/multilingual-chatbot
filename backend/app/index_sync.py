"""Keeps every provider's FAISS index complete.

Every chunk has ONE vector_id. Each provider's index stores that chunk's vector under that same id.
If a provider was down when a file was uploaded, its index simply lacks those ids; sync_provider()
embeds exactly the missing chunks later and adds them under the same ids."""
import logging
import threading

import numpy as np

from app import vector_store
from app.config import EMBEDDING_PROVIDERS
from app.database import get_conn
from app.embeddings import MAX_ATTEMPTS, EmbeddingError, embed_texts

logger = logging.getLogger("index_sync")

# Only one job at a time may write to SQLite + the FAISS indexes together.
commit_lock = threading.Lock()


def embed_all(texts: list[str]) -> dict[str, np.ndarray]:
    """Embed with every configured provider. Providers that fail are skipped;
    raises only if ALL of them fail."""
    results: dict[str, np.ndarray] = {}
    last_error: EmbeddingError | None = None
    for provider in EMBEDDING_PROVIDERS:
        try:
            results[provider] = embed_texts(texts, provider)
        except EmbeddingError as e:
            logger.warning("Embedding with %s failed: %s", provider, e)
            last_error = e
    if not results:
        raise last_error or EmbeddingError("No embedding provider is configured.", 500)
    if len(results) < len(EMBEDDING_PROVIDERS):
        missing = [p for p in EMBEDDING_PROVIDERS if p not in results]
        logger.warning("Indexed without %s; it will catch up on the next sync.", ", ".join(missing))
    return results


def sync_provider(provider: str, attempts: int = MAX_ATTEMPTS) -> int:
    """Embed every chunk that this provider's index doesn't have yet. Returns how many were added."""
    with get_conn() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT vector_id, text FROM chunks WHERE vector_id IS NOT NULL ORDER BY vector_id"
            )
        ]
    have = vector_store.all_ids(provider)
    missing = [r for r in rows if r["vector_id"] not in have]
    if not missing:
        return 0

    logger.info("Syncing %d chunk(s) into the %s index", len(missing), provider)
    vectors = embed_texts([r["text"] for r in missing], provider, attempts)

    with commit_lock:
        # A file may have been reprocessed or deleted while we were embedding: re-check.
        with get_conn() as conn:
            alive = {
                r["vector_id"]
                for r in conn.execute("SELECT vector_id FROM chunks WHERE vector_id IS NOT NULL")
            }
        present = vector_store.all_ids(provider)
        keep = [
            i for i, r in enumerate(missing)
            if r["vector_id"] in alive and r["vector_id"] not in present
        ]
        if keep:
            vector_store.add(
                provider,
                [missing[i]["vector_id"] for i in keep],
                np.ascontiguousarray(vectors[keep], dtype="float32"),
            )
    return len(keep)


def sync_all() -> None:
    """Bring every provider's index up to date (startup)."""
    for provider in EMBEDDING_PROVIDERS:
        try:
            added = sync_provider(provider)
            if added:
                print(f"[startup] Added {added} chunk(s) to the {provider} index.")
        except EmbeddingError as e:
            logger.warning("Could not fully sync the %s index: %s", provider, e)
        except Exception:
            logger.exception("Sync failed for the %s index", provider)