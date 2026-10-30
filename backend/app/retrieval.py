import logging

from app import vector_store
from app.config import EMBEDDING_PROVIDERS
from app.database import get_conn
from app.embeddings import EmbeddingError, embed_query
from app.index_sync import sync_provider

logger = logging.getLogger("retrieval")

MAX_FILTER_FETCH = 500  # when filtering by file, look this deep into the ranking


def _indexed_chunk_count() -> int:
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM chunks WHERE vector_id IS NOT NULL"
        ).fetchone()["n"]


def _search_provider(provider: str, query_vector, k: int, wanted: set | None) -> list[dict]:
    total = vector_store.total(provider)
    fetch_k = min(total, MAX_FILTER_FETCH) if wanted else k
    hits = vector_store.search(provider, query_vector, fetch_k)
    if not hits:
        return []

    ids = [vid for vid, _ in hits]
    placeholders = ",".join("?" * len(ids))
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT c.vector_id, c.chunk_id, c.file_id, c.page_number, c.text, c.language, "
            f"f.filename, f.file_type FROM chunks c JOIN files f ON f.file_id = c.file_id "
            f"WHERE c.vector_id IN ({placeholders})",
            ids,
        ).fetchall()
    by_vector = {r["vector_id"]: r for r in rows}

    results = []
    for vid, score in hits:
        r = by_vector.get(vid)
        if r is None or (wanted and r["file_id"] not in wanted):
            continue
        results.append(
            {
                "score": round(score, 4),
                "provider": provider,  # which embedding model produced this score
                "chunk_id": r["chunk_id"],
                "file_id": r["file_id"],
                "filename": r["filename"],
                "file_type": r["file_type"],
                "page_number": r["page_number"],
                "language": r["language"],
                "text": r["text"],
            }
        )
        if len(results) == k:
            break
    return results


def retrieve(question: str, k: int, file_ids: list[str] | None = None) -> list[dict]:
    """Top-k chunks for a question, best first. Optionally limited to certain files.

    The question is embedded with the primary provider and searched in THAT provider's index.
    If the provider fails, the next one is tried with its own index. Query and index always
    come from the same model, so scores are always meaningful."""
    chunk_count = _indexed_chunk_count()
    if chunk_count == 0:
        return []

    wanted = set(file_ids) if file_ids else None
    last_error: EmbeddingError | None = None

    for provider in EMBEDDING_PROVIDERS:
        try:
            if vector_store.total(provider) < chunk_count:
                # This index missed some chunks (provider was down earlier): catch up if we can.
                try:
                    sync_provider(provider, attempts=1)
                except EmbeddingError as e:
                    logger.warning("Could not catch up the %s index: %s", provider, e)
            query_vector = embed_query(question, provider)
        except EmbeddingError as e:
            logger.warning("Query embedding with %s failed (%s); trying the next provider.", provider, e)
            last_error = e
            continue
        return _search_provider(provider, query_vector, k, wanted)

    raise last_error or EmbeddingError("No embedding provider is configured.", 500)