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


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=MAX_QUESTION_CHARS)
    history: list[ChatMessage] = Field(default_factory=list)
    file_ids: list[str] | None = None  # limit search to these files
    mode: str = "auto"  # "auto", "document", "general"
    k: int = Field(TOP_K, ge=1, le=10)
    answer_language: str = "auto"  # auto = match question language


def _meta(answer_lang: str, cached: bool = False, provider: str | None = None) -> dict:
    return {
        "answer_language": answer_lang,
        "cached": cached,
        "embedding_provider": provider,
        "embedding_model": EMBEDDING_MODELS.get(provider) if provider else None,
        "gemini_calls_today": usage.calls_today(),
        "gemini_daily_limit": GEMINI_DAILY_LIMIT,
    }


def is_greeting(text: str) -> bool:
    clean = "".join(c for c in text.lower().strip() if c.isalnum() or c.isspace())
    greetings = {
        "hi", "hello", "hey", "hlo", "helo", "hoi", "hiya", "howdy",
        "good morning", "good afternoon", "good evening",
        "namaste", "namaskara", "who are you", "what can you do", "help",
        "thanks", "thank you", "ನಮಸ್ಕಾರ", "ಹಲೋ", "ಹೇಯ್", "ಧನ್ಯವಾದ", "ನಮಸ್ತೆ", "नमस्ते"
    }
    return clean in greetings or any(clean == g for g in greetings)


@router.get("/usage")
def get_usage():
    return {"gemini_calls_today": usage.calls_today(), "gemini_daily_limit": GEMINI_DAILY_LIMIT}


@router.post("")
def chat(req: ChatRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # Determine response language
    lang = req.answer_language if req.answer_language in LANGUAGES else detect_text_language(question)

    history_dicts = [{"role": m.role, "content": m.content} for m in req.history]

    # Decide if this is Document Chat or Normal General Chat
    has_target_files = bool(req.file_ids and len(req.file_ids) > 0)
    is_doc_mode = (req.mode == "document") or (req.mode == "auto" and has_target_files)

    # ---------------------------------------------------------
    # Mode 1: Document Chat (RAG)
    # ---------------------------------------------------------
    if is_doc_mode and has_target_files:
        # Check for simple greeting first to provide a friendly response
        if is_greeting(question):
            return {
                "answer": message("greeting_doc", lang),
                "answerable": True,
                "from_documents": True,
                "reason": "greeting",
                "top_score": None,
                "sources": [],
                "model": GEMINI_MODEL,
                **_meta(lang),
            }

        try:
            retrieved = retrieve(question, req.k, req.file_ids)
        except EmbeddingError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e))

        provider = retrieved[0]["provider"] if retrieved else None
        top_score = retrieved[0]["score"] if retrieved else None
        context: list[dict] = []

        if retrieved:
            th = SCORE_THRESHOLDS.get(provider, {"min": 0.30, "floor": 0.25})
            if top_score is not None and top_score >= th["min"]:
                context = [c for c in retrieved if c["score"] >= th["floor"]]

        # If no relevant chunks meet the threshold, clearly refuse without hallucinating
        if not context:
            refusal_text = message("not_enough_info", lang)
            return {
                "answer": refusal_text,
                "answerable": False,
                "from_documents": False,
                "reason": "not_in_document",
                "top_score": top_score,
                "sources": [],
                "model": None,
                **_meta(lang, provider=provider),
            }

        # Check Cache
        cache_key = usage.make_cache_key(
            question, [c["text"] for c in context], lang, f"{GEMINI_MODEL}:doc-v3"
        )
        cached = usage.cache_get(cache_key)
        if cached:
            return {**cached, **_meta(lang, cached=True, provider=provider)}

        gemini_exhausted = usage.calls_today() >= GEMINI_DAILY_LIMIT
        if gemini_exhausted and not OPENAI_LLM_ENABLED:
            return {
                "answer": message("daily_limit", lang),
                "answerable": False,
                "from_documents": False,
                "reason": "daily_limit",
                "top_score": top_score,
                "sources": context[:3],
                "model": None,
                **_meta(lang, provider=provider),
            }

        try:
            result = generate_answer(
                question,
                chunks=context,
                answer_lang=lang,
                history=history_dicts,
                is_document_mode=True,
                skip_gemini=gemini_exhausted,
            )
        except LLMError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e))

        if result["answerable"]:
            from_docs = result["from_documents"]
            used = ([context[i - 1] for i in result.get("used", [])] or context) if from_docs else []
            payload = {
                "answer": result["answer"],
                "answerable": True,
                "from_documents": from_docs,
                "reason": "answered_from_document",
                "top_score": top_score,
                "model": result.get("model"),
                "sources": used,
            }
        else:
            payload = {
                "answer": message("not_enough_info", lang),
                "answerable": False,
                "from_documents": False,
                "reason": "not_in_document",
                "top_score": top_score,
                "model": result.get("model"),
                "sources": [],
            }

        usage.cache_put(cache_key, payload)
        return {**payload, **_meta(lang, provider=provider)}

    # ---------------------------------------------------------
    # Mode 2: Normal General Chat (No document attached)
    # ---------------------------------------------------------
    cache_key = usage.make_cache_key(
        question, [], lang, f"{GEMINI_MODEL}:general-v3"
    )
    cached = usage.cache_get(cache_key)
    if cached:
        return {**cached, **_meta(lang, cached=True)}

    gemini_exhausted = usage.calls_today() >= GEMINI_DAILY_LIMIT
    if gemini_exhausted and not OPENAI_LLM_ENABLED:
        return {
            "answer": message("daily_limit", lang),
            "answerable": False,
            "from_documents": False,
            "reason": "daily_limit",
            "top_score": None,
            "sources": [],
            "model": None,
            **_meta(lang),
        }

    try:
        result = generate_answer(
            question,
            chunks=None,
            answer_lang=lang,
            history=history_dicts,
            is_document_mode=False,
            skip_gemini=gemini_exhausted,
        )
    except LLMError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e))

    payload = {
        "answer": result["answer"],
        "answerable": True,
        "from_documents": False,
        "reason": "general_chat",
        "top_score": None,
        "model": result.get("model"),
        "sources": [],
    }

    usage.cache_put(cache_key, payload)
    return {**payload, **_meta(lang)}
