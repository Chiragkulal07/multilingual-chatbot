import sqlite3
from contextlib import contextmanager

from app.config import DB_PATH


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _add_column(conn, table: str, column: str, ddl: str) -> None:
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
                file_id            TEXT PRIMARY KEY,
                filename           TEXT NOT NULL,
                stored_name        TEXT NOT NULL,
                file_type          TEXT NOT NULL,
                size_bytes         INTEGER NOT NULL,
                status             TEXT NOT NULL,
                created_at         TEXT NOT NULL,
                error_message      TEXT,
                language           TEXT NOT NULL DEFAULT 'auto',
                detected_language  TEXT,
                stage              TEXT
            )
            """
        )
        _add_column(conn, "files", "error_message", "TEXT")
        _add_column(conn, "files", "language", "TEXT NOT NULL DEFAULT 'auto'")
        _add_column(conn, "files", "detected_language", "TEXT")
        _add_column(conn, "files", "stage", "TEXT")
        # Everything processed before multilingual support was English
        conn.execute(
            "UPDATE files SET detected_language = 'en' "
            "WHERE detected_language IS NULL AND status = 'ready'"
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS extracted_pages (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id      TEXT NOT NULL,
                page_number  INTEGER NOT NULL,
                text         TEXT NOT NULL,
                method       TEXT NOT NULL,
                confidence   REAL,
                language     TEXT NOT NULL DEFAULT 'en',
                UNIQUE (file_id, page_number),
                FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE CASCADE
            )
            """
        )
        _add_column(conn, "extracted_pages", "language", "TEXT NOT NULL DEFAULT 'en'")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chunks (
                chunk_id     TEXT PRIMARY KEY,
                file_id      TEXT NOT NULL,
                page_number  INTEGER NOT NULL,
                chunk_index  INTEGER NOT NULL,
                text         TEXT NOT NULL,
                token_count  INTEGER NOT NULL,
                vector_id    INTEGER,
                language     TEXT NOT NULL DEFAULT 'en',
                FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE CASCADE
            )
            """
        )
        _add_column(conn, "chunks", "vector_id", "INTEGER")
        _add_column(conn, "chunks", "language", "TEXT NOT NULL DEFAULT 'en'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks (file_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_vector ON chunks (vector_id)")

        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS gemini_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS answer_cache ("
            "cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        _add_column(conn, "answer_cache", "expires_at", "TEXT")
        _add_column(conn, "answer_cache", "last_used", "TEXT")
        _add_column(conn, "answer_cache", "hits", "INTEGER NOT NULL DEFAULT 0")
        _add_column(conn, "answer_cache", "kind", "TEXT")
        _add_column(conn, "answer_cache", "language", "TEXT")
        # Entries from before the language-aware cache use the old key scheme and never expire
        conn.execute("DELETE FROM answer_cache WHERE expires_at IS NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_answer_cache_used ON answer_cache (last_used)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS embedding_cache (
                cache_key   TEXT PRIMARY KEY,
                vector      BLOB NOT NULL,
                provider    TEXT NOT NULL,
                task_type   TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                last_used   TEXT NOT NULL,
                hits        INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_embedding_cache_used ON embedding_cache (last_used)")

        # Chat sessions (like ChatGPT/Claude conversations)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                conversation_id  TEXT PRIMARY KEY,
                title            TEXT,
                file_id          TEXT,
                created_at       TEXT NOT NULL,
                updated_at       TEXT NOT NULL,
                FOREIGN KEY (file_id) REFERENCES files (file_id) ON DELETE SET NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id  TEXT NOT NULL,
                role             TEXT NOT NULL,
                kind             TEXT NOT NULL DEFAULT 'text',
                content          TEXT NOT NULL,
                meta             TEXT,
                created_at       TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations (conversation_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations (updated_at)")


def allocate_vector_ids(conn, count: int) -> list[int]:
    """Hand out never-reused integer IDs for FAISS vectors."""
    row = conn.execute("SELECT value FROM meta WHERE key = 'next_vector_id'").fetchone()
    start = row["value"] if row else 1
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('next_vector_id', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (start + count,),
    )
    return list(range(start, start + count))


def get_setting(key: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
