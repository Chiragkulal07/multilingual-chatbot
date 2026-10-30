import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from app.config import MAX_FILE_SIZE, UPLOAD_DIR
from app.database import get_conn
from app.languages import OCR_CHOICES
from app.processing import process_file
from app.validation import validate_upload

router = APIRouter(prefix="/api/files", tags=["files"])

FILE_COLUMNS = (
    "file_id, filename, file_type, size_bytes, status, error_message, "
    "language, detected_language, created_at"
)
MEDIA_TYPES = {"jpeg": "image/jpeg", "png": "image/png", "pdf": "application/pdf"}


def get_file_row(file_id: str):
    with get_conn() as conn:
        row = conn.execute(
            f"SELECT {FILE_COLUMNS} FROM files WHERE file_id = ?", (file_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="File not found.")
    return row


@router.post("/upload")
async def upload_files(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    language: str = Form("auto"),
):
    """Each file is validated independently. Valid files are processed in the background."""
    if language not in OCR_CHOICES:
        raise HTTPException(status_code=400, detail="Language must be auto, en, hi or kn.")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    results = []

    for upload in files:
        filename = upload.filename or "unnamed"
        data = await upload.read(MAX_FILE_SIZE + 1)

        try:
            file_type, ext = validate_upload(filename, data)
        except ValueError as e:
            results.append({"filename": filename, "status": "rejected", "error": str(e)})
            continue

        file_id = f"file_{uuid.uuid4().hex[:12]}"
        stored_name = f"{file_id}{ext}"
        (UPLOAD_DIR / stored_name).write_bytes(data)

        with get_conn() as conn:
            conn.execute(
                "INSERT INTO files (file_id, filename, stored_name, file_type, size_bytes, "
                "status, created_at, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    file_id, filename, stored_name, file_type, len(data),
                    "processing", datetime.now(timezone.utc).isoformat(), language,
                ),
            )

        background_tasks.add_task(process_file, file_id)
        results.append({"file_id": file_id, "filename": filename, "status": "processing"})

    return {"results": results}


@router.get("")
def list_files():
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT {FILE_COLUMNS} FROM files ORDER BY created_at DESC"
        ).fetchall()
    return {"files": [dict(r) for r in rows]}


@router.get("/{file_id}")
def get_file(file_id: str):
    return dict(get_file_row(file_id))


@router.get("/{file_id}/pages")
def get_pages(file_id: str):
    file_row = get_file_row(file_id)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT page_number, text, method, confidence, language FROM extracted_pages "
            "WHERE file_id = ? ORDER BY page_number",
            (file_id,),
        ).fetchall()
    return {
        "file_id": file_id,
        "filename": file_row["filename"],
        "status": file_row["status"],
        "pages": [dict(r) for r in rows],
    }


@router.get("/{file_id}/chunks")
def get_chunks(file_id: str):
    file_row = get_file_row(file_id)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT chunk_id, page_number, chunk_index, text, token_count, language FROM chunks "
            "WHERE file_id = ? ORDER BY chunk_index",
            (file_id,),
        ).fetchall()
    return {
        "file_id": file_id,
        "filename": file_row["filename"],
        "status": file_row["status"],
        "chunks": [dict(r) for r in rows],
    }


@router.post("/{file_id}/reprocess")
def reprocess_file(file_id: str, background_tasks: BackgroundTasks, language: str | None = Query(None)):
    """Re-run extraction, optionally with a different OCR language."""
    row = get_file_row(file_id)
    if row["status"] == "processing":
        raise HTTPException(status_code=409, detail="File is already being processed.")
    if language is not None and language not in OCR_CHOICES:
        raise HTTPException(status_code=400, detail="Language must be auto, en, hi or kn.")

    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET status = 'processing', error_message = NULL, "
            "language = COALESCE(?, language) WHERE file_id = ?",
            (language, file_id),
        )
    background_tasks.add_task(process_file, file_id)
    return {"file_id": file_id, "status": "processing"}


@router.get("/{file_id}/original")
def get_original(file_id: str):
    """Serve the stored original so the browser can display it inline."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT filename, stored_name, file_type FROM files WHERE file_id = ?", (file_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="File not found.")

    path = (UPLOAD_DIR / row["stored_name"]).resolve()
    if UPLOAD_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="The original file is missing from storage.")

    return FileResponse(
        path,
        media_type=MEDIA_TYPES[row["file_type"]],
        filename=row["filename"],
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff"},
    )