from fastapi import APIRouter, HTTPException, Query

from app import vector_store
from app.config import EMBEDDING_PROVIDERS
from app.database import get_conn
from app.embeddings import EmbeddingError
from app.retrieval import retrieve

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
def search(q: str = Query(..., max_length=1000), k: int = Query(5, ge=1, le=20)):
    question = q.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    try:
        hits = retrieve(question, k)
    except EmbeddingError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))

    results = [{"rank": i, **h} for i, h in enumerate(hits, start=1)]
    return {
        "query": question,
        "provider": hits[0]["provider"] if hits else None,  # which embedding model answered
        "results": results,
    }


@router.get("/stats")
def stats():
    with get_conn() as conn:
        chunks = conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"]
        embedded = conn.execute(
            "SELECT COUNT(*) AS n FROM chunks WHERE vector_id IS NOT NULL"
        ).fetchone()["n"]
    return {
        "chunks": chunks,
        "chunks_with_vectors": embedded,
        "vectors_in_index": {p: vector_store.total(p) for p in EMBEDDING_PROVIDERS},
    }