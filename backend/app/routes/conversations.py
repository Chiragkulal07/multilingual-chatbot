"""Chat sessions: each conversation keeps its own message history and attached document."""

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.database import get_conn

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

TITLE_MAX = 60
HISTORY_TURNS = 6


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_title(text: str) -> str:
    clean = " ".join(text.split())
    return clean if len(clean) <= TITLE_MAX else clean[: TITLE_MAX - 1].rstrip() + "…"


def _conv_row(conn, conversation_id: str):
    return conn.execute(
        "SELECT c.conversation_id, c.title, c.file_id, c.created_at, c.updated_at, "
        "f.filename, f.file_type, f.size_bytes, f.status, f.detected_language "
        "FROM conversations c LEFT JOIN files f ON f.file_id = c.file_id "
        "WHERE c.conversation_id = ?",
        (conversation_id,),
    ).fetchone()


def _conv_dict(row) -> dict:
    active_file = None
    if row["file_id"] and row["filename"]:
        active_file = {
            "file_id": row["file_id"],
            "filename": row["filename"],
            "file_type": row["file_type"],
            "size_bytes": row["size_bytes"],
            "status": row["status"],
            "detected_language": row["detected_language"],
        }
    return {
        "conversation_id": row["conversation_id"],
        "title": row["title"] or "New chat",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "active_file": active_file,
    }


def _msg_dict(row) -> dict:
    return {
        "id": row["id"],
        "role": row["role"],
        "kind": row["kind"],
        "content": row["content"],
        "meta": json.loads(row["meta"]) if row["meta"] else {},
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------------------
# Helpers used by the chat route
# ---------------------------------------------------------------------------
def create_conversation(title: str | None = None, file_id: str | None = None) -> str:
    cid = uuid.uuid4().hex
    now = _now()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO conversations (conversation_id, title, file_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (cid, title, file_id, now, now),
        )
    return cid


def conversation_exists(conversation_id: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM conversations WHERE conversation_id = ?", (conversation_id,)
        ).fetchone()
    return row is not None


def load_history(conversation_id: str, limit: int = HISTORY_TURNS) -> list[dict]:
    """Most recent text turns, oldest first, in the shape the LLM layer expects."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT role, content FROM messages "
            "WHERE conversation_id = ? AND kind = 'text' ORDER BY id DESC LIMIT ?",
            (conversation_id, limit),
        ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def save_exchange(conversation_id: str, question: str, user_meta: dict, answer: str, answer_meta: dict) -> None:
    now = _now()
    with get_conn() as conn:
        file_ids = user_meta.get("file_ids") or []
        if file_ids:
            row = conn.execute("SELECT filename FROM files WHERE file_id = ?", (file_ids[0],)).fetchone()
            if row:
                user_meta = {**user_meta, "attached_filename": row["filename"]}
        conn.execute(
            "INSERT INTO messages (conversation_id, role, kind, content, meta, created_at) "
            "VALUES (?, 'user', 'text', ?, ?, ?)",
            (conversation_id, question, json.dumps(user_meta, ensure_ascii=False), now),
        )
        conn.execute(
            "INSERT INTO messages (conversation_id, role, kind, content, meta, created_at) "
            "VALUES (?, 'assistant', 'text', ?, ?, ?)",
            (conversation_id, answer, json.dumps(answer_meta, ensure_ascii=False), now),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ?, title = COALESCE(title, ?) WHERE conversation_id = ?",
            (now, _make_title(question), conversation_id),
        )


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
class CreateConversation(BaseModel):
    title: str | None = Field(None, max_length=200)


class UpdateConversation(BaseModel):
    title: str | None = Field(None, max_length=200)
    detach_file: bool = False


class AttachFile(BaseModel):
    file_id: str


@router.get("")
def list_conversations():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT c.conversation_id, c.title, c.file_id, c.created_at, c.updated_at, "
            "f.filename, f.file_type, f.size_bytes, f.status, f.detected_language "
            "FROM conversations c LEFT JOIN files f ON f.file_id = c.file_id "
            "ORDER BY c.updated_at DESC"
        ).fetchall()
    return {"conversations": [_conv_dict(r) for r in rows]}


@router.post("")
def new_conversation(body: CreateConversation | None = None):
    cid = create_conversation(title=(body.title.strip() or None) if body and body.title else None)
    with get_conn() as conn:
        return _conv_dict(_conv_row(conn, cid))


@router.get("/{conversation_id}")
def get_conversation(conversation_id: str):
    with get_conn() as conn:
        row = _conv_row(conn, conversation_id)
        if not row:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        msgs = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id", (conversation_id,)
        ).fetchall()
    return {**_conv_dict(row), "messages": [_msg_dict(m) for m in msgs]}


@router.patch("/{conversation_id}")
def update_conversation(conversation_id: str, body: UpdateConversation):
    with get_conn() as conn:
        if not _conv_row(conn, conversation_id):
            raise HTTPException(status_code=404, detail="Conversation not found.")
        if body.title is not None:
            title = body.title.strip()
            if not title:
                raise HTTPException(status_code=400, detail="Title cannot be empty.")
            conn.execute(
                "UPDATE conversations SET title = ? WHERE conversation_id = ?", (title, conversation_id)
            )
        if body.detach_file:
            conn.execute(
                "UPDATE conversations SET file_id = NULL WHERE conversation_id = ?", (conversation_id,)
            )
        return _conv_dict(_conv_row(conn, conversation_id))


@router.delete("/{conversation_id}")
def delete_conversation(conversation_id: str):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE conversation_id = ?", (conversation_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"deleted": conversation_id}


@router.post("/{conversation_id}/attach")
def attach_file(conversation_id: str, body: AttachFile):
    """Make a processed document the active context of this conversation."""
    now = _now()
    with get_conn() as conn:
        if not _conv_row(conn, conversation_id):
            raise HTTPException(status_code=404, detail="Conversation not found.")
        f = conn.execute(
            "SELECT file_id, filename, file_type, size_bytes, detected_language FROM files WHERE file_id = ?",
            (body.file_id,),
        ).fetchone()
        if not f:
            raise HTTPException(status_code=404, detail="File not found.")
        meta = {
            "file_id": f["file_id"],
            "filename": f["filename"],
            "file_type": f["file_type"],
            "size_bytes": f["size_bytes"],
            "detected_language": f["detected_language"],
        }
        conn.execute(
            "INSERT INTO messages (conversation_id, role, kind, content, meta, created_at) "
            "VALUES (?, 'assistant', 'file', ?, ?, ?)",
            (
                conversation_id,
                f"{f['filename']} has been analyzed and indexed. You can now ask questions about it.",
                json.dumps(meta, ensure_ascii=False),
                now,
            ),
        )
        conn.execute(
            "UPDATE conversations SET file_id = ?, updated_at = ?, title = COALESCE(title, ?) "
            "WHERE conversation_id = ?",
            (f["file_id"], now, _make_title(f["filename"]), conversation_id),
        )
        return _conv_dict(_conv_row(conn, conversation_id))
