from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS, UPLOAD_DIR
from app.database import init_db
from app.processing import (
    backfill_chunks,
    backfill_embeddings,
    migrate_embedding_model,
    reconcile_index,
    recover_interrupted,
)
from app.routes import chat, files, search


@asynccontextmanager
async def lifespan(app: FastAPI):
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    recover_interrupted()
    backfill_chunks()
    migrate_embedding_model()  # new embedding model => wipe and rebuild the index
    reconcile_index()
    backfill_embeddings()
    yield


app = FastAPI(title="OCR RAG Chatbot", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files.router)
app.include_router(search.router)
app.include_router(chat.router)


@app.get("/health")
def health():
    return {"status": "ok"}