from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import cache, usage
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
from app.routes import conversations as convs
from app.tracing import annotate, traceable

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
    conversation_id: str | None = None  # persist this exchange into a chat session


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


@router.get("/cache")
def cache_stats():
    """Cached answers per language/kind and cached embeddings per provider, with hit counts."""
    return cache.stats()


@router.delete("/cache")
def clear_cache(scope: str = "answers"):
    """scope: 'answers' (default), 'embeddings' or 'all'."""
    if scope not in ("answers", "embeddings", "all"):
        raise HTTPException(status_code=400, detail="scope must be 'answers', 'embeddings' or 'all'.")
    return cache.clear(scope)


@router.post("")
def chat(req: ChatRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    # Determine response language
    lang = req.answer_language if req.answer_language in LANGUAGES else detect_text_language(question)

    # Sessions: history comes from the stored conversation; a new one is created if needed
    conversation_id = req.conversation_id
    if conversation_id and not convs.conversation_exists(conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    if conversation_id:
        history_dicts = convs.load_history(conversation_id)
    else:
        history_dicts = [{"role": m.role, "content": m.content} for m in req.history]
        conversation_id = convs.create_conversation()

    response = _answer(req, question, lang, history_dicts)

    convs.save_exchange(
        conversation_id,
        question,
        {"file_ids": req.file_ids or []},
        response["answer"],
        {
            "sources": response.get("sources") or [],
            "from_documents": response.get("from_documents", False),
            "reason": response.get("reason"),
            "model": response.get("model"),
        },
    )
    return {**response, "conversation_id": conversation_id}


@traceable(name="chat", run_type="chain", process_inputs=lambda d: {
    "question": d["question"], "lang": d["lang"], "history_turns": len(d["history_dicts"]),
    "mode": d["req"].mode, "file_ids": d["req"].file_ids, "k": d["req"].k})
def _answer(req: ChatRequest, question: str, lang: str, history_dicts: list[dict]) -> dict:

    # Decide if this is Document Chat or Normal General Chat
    has_target_files = bool(req.file_ids and len(req.file_ids) > 0)
    is_doc_mode = (req.mode == "document") or (req.mode == "auto" and has_target_files)
    annotate(doc_mode=is_doc_mode and has_target_files)

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
            annotate(refused="no chunk above score threshold", top_score=top_score)
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

        # Check cache: same normalized question + same context chunks + same answer language.
        # Follow-ups depend on the conversation, so they always go to the model.
        cache_key = cache.answer_key(question, lang, f"{GEMINI_MODEL}:doc", [c["text"] for c in context])
        cached = None if history_dicts else cache.get_answer(cache_key)
        annotate(answer_cache_hit=bool(cached), context_chunks=len(context), top_score=top_score)
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

        if not history_dicts:
            cache.put_answer(cache_key, payload, "document" if payload["answerable"] else "refusal", lang)
        return {**payload, **_meta(lang, provider=provider)}

    # ---------------------------------------------------------
    # Mode 2: Normal General Chat (No document attached)
    # ---------------------------------------------------------
    cache_key = cache.answer_key(question, lang, f"{GEMINI_MODEL}:general")
    cached = None if history_dicts else cache.get_answer(cache_key)
    annotate(answer_cache_hit=bool(cached))
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

    if not history_dicts:
        cache.put_answer(cache_key, payload, "general", lang)
    return {**payload, **_meta(lang)}
