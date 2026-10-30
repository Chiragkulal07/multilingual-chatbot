import logging
import threading

from app import vector_store
from app.chunking import chunk_pages
from app.config import EMBEDDING_PROVIDERS, FAISS_INDEX_PATH, UPLOAD_DIR, embedding_id
from app.database import allocate_vector_ids, get_conn, get_setting, set_setting
from app.extraction import extract_file
from app.index_sync import commit_lock, embed_all, sync_all

logger = logging.getLogger("processing")

# PaddleOCR is not safe to run from several threads at once, so jobs take turns.
_extraction_lock = threading.Lock()


def set_status(file_id: str, status: str, error: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET status = ?, error_message = ? WHERE file_id = ?",
            (status, error, file_id),
        )


def _insert_chunks(conn, chunks: list[dict]) -> None:
    conn.executemany(
        "INSERT INTO chunks (chunk_id, file_id, page_number, chunk_index, text, "
        "token_count, vector_id, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                c["chunk_id"], c["file_id"], c["page_number"], c["chunk_index"],
                c["text"], c["token_count"], c.get("vector_id"), c.get("language", "en"),
            )
            for c in chunks
        ],
    )


def process_file(file_id: str) -> None:
    """Background job: extract, chunk, embed, index, then mark ready."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT stored_name, file_type, language FROM files WHERE file_id = ?", (file_id,)
        ).fetchone()
    if row is None:
        return

    try:
        with _extraction_lock:
            pages = extract_file(UPLOAD_DIR / row["stored_name"], row["file_type"], row["language"])

        if not any(p["text"] for p in pages):
            set_status(file_id, "failed", "No readable text was found in this file.")
            return

        chunks = chunk_pages(file_id, pages)
        if not chunks:
            set_status(file_id, "failed", "No readable text was found in this file.")
            return

        langs = [p["language"] for p in pages if p["text"]]
        detected = max(set(langs), key=langs.count) if langs else "en"

        # One vector per provider. A provider that is down is skipped (it catches up later);
        # the file only fails if EVERY provider fails.
        vectors_by_provider = embed_all([c["text"] for c in chunks])

        with commit_lock:
            with get_conn() as conn:
                old_ids = [
                    r["vector_id"]
                    for r in conn.execute(
                        "SELECT vector_id FROM chunks WHERE file_id = ? AND vector_id IS NOT NULL",
                        (file_id,),
                    )
                ]

            new_ids = None
            try:
                with get_conn() as conn:
                    new_ids = allocate_vector_ids(conn, len(chunks))
                    for provider, vectors in vectors_by_provider.items():
                        vector_store.add(provider, new_ids, vectors)  # same ids in every index
                    for chunk, vector_id in zip(chunks, new_ids):
                        chunk["vector_id"] = vector_id

                    conn.execute("DELETE FROM chunks WHERE file_id = ?", (file_id,))
                    conn.execute("DELETE FROM extracted_pages WHERE file_id = ?", (file_id,))
                    conn.executemany(
                        "INSERT INTO extracted_pages (file_id, page_number, text, method, "
                        "confidence, language) VALUES (?, ?, ?, ?, ?, ?)",
                        [
                            (file_id, p["page_number"], p["text"], p["method"], p["confidence"], p["language"])
                            for p in pages
                        ],
                    )
                    _insert_chunks(conn, chunks)
                    conn.execute(
                        "UPDATE files SET status = 'ready', error_message = NULL, "
                        "detected_language = ? WHERE file_id = ?",
                        (detected, file_id),
                    )
            except Exception:
                if new_ids:
                    vector_store.remove_everywhere(new_ids)  # undo if the DB write failed
                raise

            vector_store.remove_everywhere(old_ids)  # reprocessing: drop the previous vectors
    except Exception as e:
        logger.exception("Processing failed for %s", file_id)
        set_status(file_id, "failed", f"Processing failed: {e}")


def backfill_chunks() -> None:
    """Files that are 'ready' but have no chunks: chunk them from saved text (no OCR needed)."""
    with get_conn() as conn:
        file_ids = [
            r["file_id"]
            for r in conn.execute(
                "SELECT file_id FROM files WHERE status = 'ready' "
                "AND file_id NOT IN (SELECT DISTINCT file_id FROM chunks)"
            )
        ]
    for file_id in file_ids:
        try:
            with get_conn() as conn:
                pages = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT page_number, text, language FROM extracted_pages WHERE file_id = ?",
                        (file_id,),
                    )
                ]
                _insert_chunks(conn, chunk_pages(file_id, pages))
        except Exception:
            logger.exception("Chunk backfill failed for %s", file_id)


def migrate_embedding_model() -> None:
    """If a provider's model or vector size changed, that provider's index is useless: delete it.
    sync_all() (run from backfill_embeddings) then re-embeds the chunks into a fresh index."""
    FAISS_INDEX_PATH.unlink(missing_ok=True)  # the old single index from the local-model days
    for provider in EMBEDDING_PROVIDERS:
        current = embedding_id(provider)
        if get_setting(f"embedding_model_{provider}") != current:
            print(f"[startup] {provider} embedding setup is now {current}. Rebuilding its index.")
            vector_store.reset(provider)
        set_setting(f"embedding_model_{provider}", current)


def reconcile_index() -> None:
    """Remove vectors that no chunk points to (after crashes or manual DB changes)."""
    with get_conn() as conn:
        db_ids = {
            r["vector_id"]
            for r in conn.execute("SELECT vector_id FROM chunks WHERE vector_id IS NOT NULL")
        }
    for provider in EMBEDDING_PROVIDERS:
        orphans = vector_store.all_ids(provider) - db_ids
        if orphans:
            vector_store.remove(provider, list(orphans))


def backfill_embeddings() -> None:
    """Give an id and vectors to chunks that have none, then fill any index that is behind."""
    with get_conn() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT chunk_id, text FROM chunks WHERE vector_id IS NULL ORDER BY chunk_id"
            )
        ]
    if rows:
        print(f"[startup] Embedding {len(rows)} new chunk(s) with the cloud embedding API...")
        try:
            vectors_by_provider = embed_all([r["text"] for r in rows])
            with commit_lock:
                new_ids = None
                try:
                    with get_conn() as conn:
                        new_ids = allocate_vector_ids(conn, len(rows))
                        for provider, vectors in vectors_by_provider.items():
                            vector_store.add(provider, new_ids, vectors)
                        conn.executemany(
                            "UPDATE chunks SET vector_id = ? WHERE chunk_id = ?",
                            [(vid, r["chunk_id"]) for vid, r in zip(new_ids, rows)],
                        )
                except Exception:
                    if new_ids:
                        vector_store.remove_everywhere(new_ids)
                    raise
        except Exception:
            logger.exception("Embedding backfill failed")

    sync_all()  # re-embeds into any index that is empty or behind (also handles model changes)
    print("[startup] Embedding done.")


def recover_interrupted() -> None:
    """If the server stopped mid-job, don't leave files stuck on 'processing'."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET status = 'failed', "
            "error_message = 'Processing was interrupted by a server restart. Use reprocess.' "
            "WHERE status = 'processing'"
        )