import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app import cache
from app.config import CORS_ORIGINS, UPLOAD_DIR
from app.database import init_db
from app.processing import (
    backfill_chunks,
    backfill_embeddings,
    migrate_embedding_model,
    reconcile_index,
    recover_interrupted,
    start_warm_up,
)
from app.routes import chat, conversations, files, search


@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    cache.prune()  # drop expired answers and trim oversized caches
    recover_interrupted()
    backfill_chunks()
    migrate_embedding_model()  # new embedding model => wipe and rebuild the index
    reconcile_index()
    backfill_embeddings()
    start_warm_up()  # load OCR models + API clients in the background
    yield


app = FastAPI(title="OCR RAG Chatbot", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins="https://multilingual-chatbot-52ob.onrender.com",
    allow_methods=["*"],
    allow_headers=["*"],
)

timing_log = logging.getLogger("uvicorn.error")


@app.middleware("http")
async def log_request_time(request: Request, call_next):
    """Print how long every API request takes (works with or without LangSmith)."""
    start = time.perf_counter()
    response = await call_next(request)
    ms = (time.perf_counter() - start) * 1000
    response.headers["X-Response-Time-ms"] = f"{ms:.0f}"
    if request.url.path.startswith("/api"):
        timing_log.info("%s %s -> %s in %.0f ms", request.method, request.url.path, response.status_code, ms)
    return response


app.include_router(files.router)
app.include_router(search.router)
app.include_router(chat.router)
app.include_router(conversations.router)


@app.get("/health")
def health():
    return {"status": "ok"}