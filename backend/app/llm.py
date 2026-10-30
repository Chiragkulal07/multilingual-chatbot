import logging
import httpx
from google import genai
from google.genai import errors, types
from pydantic import BaseModel

from app import usage
from app.config import (
    GEMINI_API_KEY,
    GEMINI_FALLBACK_MODEL,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_MODEL,
    GEMINI_TIMEOUT_MS,
    OPENAI_API_KEY,
    OPENAI_LLM_ENABLED,
    OPENAI_LLM_MODEL,
    OPENAI_MAX_OUTPUT_TOKENS,
)
from app.languages import LANGUAGES, message

logger = logging.getLogger("llm")


class LLMError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class _Fail(Exception):
    def __init__(self, detail: str, code: int | None = None):
        super().__init__(detail)
        self.code = code


class AnswerSchema(BaseModel):
    answerable: bool
    from_documents: bool
    answer: str
    sources_used: list[int]


class GeneralAnswerSchema(BaseModel):
    answer: str


def build_document_system_instruction(answer_lang: str) -> str:
    refusal = message("not_enough_info", answer_lang)
    name = LANGUAGES.get(answer_lang, "English")
    return f"""You are a precise, grounded document assistant.
You are given numbered passages extracted from uploaded documents inside <passage> tags, followed by the user question.

STRICT INSTRUCTIONS:
1. Answer the question using ONLY the facts directly stated in the provided passages.
2. Do NOT extrapolate, speculate, or introduce external facts.
3. If the provided passages do NOT contain enough information to answer the question, set answerable to false, from_documents to false, sources_used to [], and set answer to EXACTLY:
   "{refusal}"
4. Never invent or hallucinate information that is not in the passages.
5. If the user is just saying a friendly greeting or pleasantry (e.g. "hi", "hello", "thanks"), respond politely in one brief sentence and offer to help with the document.
6. Never start your response with phrases like "Even though I don't have the context...", "Based on general knowledge...", or disclaimers about documents.
7. Always respond in {name}.
8. Do not insert passage citations like [1] or [2] inside the text."""


def build_general_system_instruction(answer_lang: str) -> str:
    name = LANGUAGES.get(answer_lang, "English")
    return f"""You are a helpful, intelligent, polite, and accurate AI assistant.
Answer the user's questions conversationally, accurately, and naturally in {name}.
Do not mention missing documents or missing context. Answer directly, naturally, and helpfully."""


# Backward compatibility export
SYSTEM_INSTRUCTION = build_document_system_instruction("en")


_client = None
_openai_client = None


def _get_client():
    global _client
    if _client is None:
        if not GEMINI_API_KEY:
            raise LLMError("GEMINI_API_KEY is not set. Add it to backend/.env and restart the server.", 500)
        try:
            http = types.HttpOptions(
                timeout=GEMINI_TIMEOUT_MS, retry_options=types.HttpRetryOptions(attempts=1)
            )
        except Exception:
            http = types.HttpOptions(timeout=GEMINI_TIMEOUT_MS)
        _client = genai.Client(api_key=GEMINI_API_KEY, http_options=http)
    return _client


def _get_openai_client():
    global _openai_client
    if _openai_client is None:
        if not OPENAI_API_KEY:
            raise LLMError("OPENAI_API_KEY is not set. Add it to backend/.env and restart the server.", 500)
        try:
            import openai
        except ImportError:
            raise LLMError("The openai package is not installed. Run: pip install openai", 500)
        _openai_client = openai.OpenAI(
            api_key=OPENAI_API_KEY, timeout=GEMINI_TIMEOUT_MS / 1000, max_retries=0
        )
    return _openai_client


def build_prompt(
    question: str,
    chunks: list[dict] | None = None,
    history: list[dict] | None = None,
    is_document_mode: bool = True,
) -> str:
    parts = []

    # Include recent conversation history for memory
    if history:
        history_lines = []
        for turn in history[-6:]:
            role = "User" if turn.get("role") == "user" else "Assistant"
            content = (turn.get("content") or turn.get("text") or "").strip()
            if content:
                history_lines.append(f"{role}: {content}")
        if history_lines:
            parts.append("Previous Conversation:\n" + "\n".join(history_lines))

    if is_document_mode and chunks:
        passage_blocks = []
        for i, c in enumerate(chunks, start=1):
            filename = c.get("filename", "document").replace('"', "'")
            page = c.get("page_number", 1)
            passage_blocks.append(
                f'<passage id="{i}" file="{filename}" page="{page}">\n{c.get("text", "")}\n</passage>'
            )
        parts.append("Document Passages:\n" + "\n\n".join(passage_blocks))
    elif is_document_mode:
        parts.append("Document Passages:\n(no matching passages were found in the document)")

    parts.append(f"Current Question: {question}")
    return "\n\n".join(parts)


def _parse_doc_response(text: str | None, num_chunks: int, answer_lang: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    if not text:
        raise ValueError("empty response (possibly blocked by a safety filter)")
    data = AnswerSchema.model_validate_json(text)
    used = sorted({i for i in data.sources_used if 1 <= i <= num_chunks}) if data.from_documents else []
    answer = data.answer.strip()
    refusal = message("not_enough_info", answer_lang)

    if not data.answerable:
        answer = refusal

    return {
        "answerable": data.answerable,
        "from_documents": data.from_documents,
        "answer": answer,
        "used": used,
    }


def _gemini_doc_attempt(model: str, prompt: str, system: str, num_chunks: int, answer_lang: str) -> dict:
    try:
        client = _get_client()
    except LLMError as e:
        raise _Fail(str(e), 401)
    usage.record_call()
    config = types.GenerateContentConfig(
        system_instruction=system,
        temperature=0.1,  # low temperature for strict factual adherence
        max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS,
        response_mime_type="application/json",
        response_schema=AnswerSchema,
    )
    try:
        response = client.models.generate_content(model=model, contents=prompt, config=config)
        return {**_parse_doc_response(response.text, num_chunks, answer_lang), "model": model}
    except errors.APIError as e:
        raise _Fail(str(e), getattr(e, "code", None))
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise _Fail(str(e), 504)
    except ValueError as e:
        raise _Fail(f"unusable answer: {e}")


def _gemini_general_attempt(model: str, prompt: str, system: str) -> dict:
    try:
        client = _get_client()
    except LLMError as e:
        raise _Fail(str(e), 401)
    usage.record_call()
    config = types.GenerateContentConfig(
        system_instruction=system,
        temperature=0.7,
        max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS,
    )
    try:
        response = client.models.generate_content(model=model, contents=prompt, config=config)
        text = (response.text or "").strip()
        return {
            "answerable": True,
            "from_documents": False,
            "answer": text,
            "used": [],
            "model": model,
        }
    except errors.APIError as e:
        raise _Fail(str(e), getattr(e, "code", None))
    except (httpx.TimeoutException, httpx.TransportError) as e:
        raise _Fail(str(e), 504)
    except ValueError as e:
        raise _Fail(f"unusable answer: {e}")


# Some OpenAI models (reasoning-style ones) only accept the default temperature.
# Once a model rejects a custom temperature we remember it and stop sending one.
_openai_temperature_unsupported = False


def _openai_chat_completion(client, **kwargs):
    """Call chat.completions.create, retrying once without `temperature` if the model rejects it."""
    global _openai_temperature_unsupported
    import openai

    if _openai_temperature_unsupported:
        kwargs.pop("temperature", None)
    try:
        return client.chat.completions.create(**kwargs)
    except openai.BadRequestError as e:
        if "temperature" in kwargs and "temperature" in str(e).lower():
            logger.info("OpenAI model %s does not accept a custom temperature; retrying without it", kwargs.get("model"))
            _openai_temperature_unsupported = True
            kwargs.pop("temperature", None)
            return client.chat.completions.create(**kwargs)
        raise


def _openai_doc_attempt(system: str, prompt: str, num_chunks: int, answer_lang: str) -> dict:
    try:
        client = _get_openai_client()
    except LLMError as e:
        raise _Fail(str(e), 401)
    import openai

    json_hint = (
        "\n\nReturn ONLY a JSON object with exactly these keys: "
        '"answerable" (boolean), "from_documents" (boolean), "answer" (string), '
        '"sources_used" (array of integers).'
    )
    try:
        response = _openai_chat_completion(
            client,
            model=OPENAI_LLM_MODEL,
            messages=[
                {"role": "system", "content": system + json_hint},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=OPENAI_MAX_OUTPUT_TOKENS,
            temperature=0.1,
        )
        text = response.choices[0].message.content
        return {**_parse_doc_response(text, num_chunks, answer_lang), "model": f"openai/{OPENAI_LLM_MODEL}"}
    except openai.APIStatusError as e:
        raise _Fail(str(e), e.status_code)
    except (openai.APITimeoutError, openai.APIConnectionError) as e:
        raise _Fail(str(e), 504)
    except ValueError as e:
        raise _Fail(f"unusable answer: {e}")


def _openai_general_attempt(system: str, prompt: str) -> dict:
    try:
        client = _get_openai_client()
    except LLMError as e:
        raise _Fail(str(e), 401)
    import openai

    try:
        response = _openai_chat_completion(
            client,
            model=OPENAI_LLM_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            max_completion_tokens=OPENAI_MAX_OUTPUT_TOKENS,
            temperature=0.7,
        )
        text = (response.choices[0].message.content or "").strip()
        return {
            "answerable": True,
            "from_documents": False,
            "answer": text,
            "used": [],
            "model": f"openai/{OPENAI_LLM_MODEL}",
        }
    except openai.APIStatusError as e:
        raise _Fail(str(e), e.status_code)
    except (openai.APITimeoutError, openai.APIConnectionError) as e:
        raise _Fail(str(e), 504)


def generate_answer(
    question: str,
    chunks: list[dict] | None = None,
    answer_lang: str = "en",
    history: list[dict] | None = None,
    is_document_mode: bool = False,
    skip_gemini: bool = False,
) -> dict:
    """Route to Document QA or General Conversational LLM based on is_document_mode."""
    chunks = chunks or []
    prompt = build_prompt(question, chunks=chunks, history=history, is_document_mode=is_document_mode)

    if is_document_mode:
        system = build_document_system_instruction(answer_lang)
    else:
        system = build_general_system_instruction(answer_lang)

    attempts = []
    if not skip_gemini:
        for model in [m for m in (GEMINI_MODEL, GEMINI_FALLBACK_MODEL) if m]:
            if is_document_mode:
                attempts.append(
                    (model, lambda m=model: _gemini_doc_attempt(m, prompt, system, len(chunks), answer_lang))
                )
            else:
                attempts.append(
                    (model, lambda m=model: _gemini_general_attempt(m, prompt, system))
                )

    if OPENAI_LLM_ENABLED:
        if is_document_mode:
            attempts.append(
                (f"openai/{OPENAI_LLM_MODEL}", lambda: _openai_doc_attempt(system, prompt, len(chunks), answer_lang))
            )
        else:
            attempts.append(
                (f"openai/{OPENAI_LLM_MODEL}", lambda: _openai_general_attempt(system, prompt))
            )

    if not attempts:
        raise LLMError("No language model is available right now. Please check your API configuration.", 429)

    last: _Fail | None = None
    for name, attempt in attempts:
        try:
            return attempt()
        except _Fail as f:
            logger.warning("LLM %s failed: %s %s", name, f.code, f)
            last = f

    code = last.code if last else None
    if code in (401, 403):
        raise LLMError("The language model API key was rejected or is missing. Check your API key in backend/.env.", 500)
    if code == 404:
        raise LLMError("Configured language model not found. Check GEMINI_MODEL / OPENAI_LLM_MODEL in backend/.env.", 500)
    if code == 429:
        raise LLMError("Rate limit reached. Please wait a minute and try again.", 429)
    if code == 504:
        raise LLMError("The language model timed out. Please try again.", 504)
    if code == 400:
        # Surface the provider's own explanation (first line only) so misconfigurations are visible.
        detail = str(last).splitlines()[0][:200] if last else ""
        raise LLMError(f"The language model rejected the request: {detail}", 502)
    raise LLMError("Could not get an answer from the language model. Please try again.", 502)
