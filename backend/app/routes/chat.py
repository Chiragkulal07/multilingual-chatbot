from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import usage
from app.config import (
    EMBEDDING_MODELS,
    GEMINI_DAILY_LIMIT,
    GEMINI_MODEL,
    MAX_QUESTION_CHARS,
    OPENAI_LLM_ENABLED,
    SCORE_THRESHOLDS,
    TOP_K,
)
from app.embeddings import EmbeddingError
from app.languages import LANGUAGES, detect_text_language, message
from app.llm import LLMError, generate_answer
from app.retrieval import retrieve

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION_CHARS)
    file_ids: list[str] | None = None  # limit the search to these files
    k: int = Field(TOP_K, ge=1, le=10)
    answer_language: str = "auto"  # auto = same language as the question


def _meta(answer_lang: str, cached: bool = False, provider: str | None = None) -> dict:
    return {
        "answer_language": answer_lang,
        "cached": cached,
        "embedding_provider": provider,  # which embedding model did the retrieval
        "embedding_model": EMBEDDING_MODELS.get(provider) if provider else None,
        "gemini_calls_today": usage.calls_today(),
        "gemini_daily_limit": GEMINI_DAILY_LIMIT,
    }


def _no_answer(text: str, reason: str, top_score, lang: str, sources=None, provider: str | None = None) -> dict:
    return {
        "answer": text,
        "answerable": False,
        "from_documents": False,
        "reason": reason,
        "top_score": top_score,
        "sources": sources or [],
        "model": None,
        **_meta(lang, provider=provider),
    }


@router.get("/usage")
def get_usage():
    return {"gemini_calls_today": usage.calls_today(), "gemini_daily_limit": GEMINI_DAILY_LIMIT}


@router.post("")
def chat(req: ChatRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # Language of the answer: chosen explicitly, otherwise the script the question is written in
    lang = req.answer_language if req.answer_language in LANGUAGES else detect_text_language(question)

    try:
        retrieved = retrieve(question, req.k, req.file_ids)
    except EmbeddingError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))

    # Which passages (if any) are relevant enough to show the model.
    # No relevant passages is NOT an error any more: the model then answers general questions
    # from its own knowledge and says so, and refuses questions that are about the documents.
    provider = retrieved[0]["provider"] if retrieved else None
    top_score = retrieved[0]["score"] if retrieved else None
    context: list[dict] = []
    if retrieved:
        th = SCORE_THRESHOLDS[provider]
        if top_score >= th["min"]:
            context = [c for c in retrieved if c["score"] >= th["floor"]]

    # "hybrid-v2" makes answers saved by the old document-only version get ignored
    cache_key = usage.make_cache_key(
        question, [c["text"] for c in context], lang, f"{GEMINI_MODEL}:hybrid-v2"
    )
    cached = usage.cache_get(cache_key)
    if cached:
        return {**cached, **_meta(lang, cached=True, provider=provider)}

    # Daily Gemini cap reached: use the OpenAI fallback if it is set up, otherwise show the passages
    gemini_exhausted = usage.calls_today() >= GEMINI_DAILY_LIMIT
    if gemini_exhausted and not OPENAI_LLM_ENABLED:
        return _no_answer(
            message("daily_limit", lang), "daily_limit", top_score, lang, context[:3], provider=provider
        )

    try:
        result = generate_answer(question, context, lang, skip_gemini=gemini_exhausted)
    except LLMError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))

    if result["answerable"]:
        from_docs = result["from_documents"]
        # Document answers cite their passages; general-knowledge answers cite nothing
        used = ([context[i - 1] for i in result["used"]] or context) if from_docs else []
        payload = {
            "answer": result["answer"],
            "answerable": True,
            "from_documents": from_docs,
            "reason": "answered" if from_docs else "general_knowledge",
            "top_score": top_score,
            "model": result["model"],
            "sources": used,
        }
    else:
        payload = {
            "answer": result["answer"],
            "answerable": False,
            "from_documents": False,
            "reason": "model_insufficient",
            "top_score": top_score,
            "model": result["model"],
            "sources": [],
        }

    usage.cache_put(cache_key, payload)
    return {**payload, **_meta(lang, provider=provider)}