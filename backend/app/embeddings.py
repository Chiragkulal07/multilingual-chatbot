"""Cloud embeddings. Each call names its provider ("gemini" or "openai"); fallback between
providers is handled in retrieval.py / index_sync.py, because each provider has its own index."""
import logging
import time

import httpx
import numpy as np
from google.genai import errors, types

from app import cache
from app.config import EMBEDDING_BATCH_SIZE, EMBEDDING_DIM, EMBEDDING_MODELS, EMBEDDING_PROVIDERS
from app.tracing import annotate, compact, traceable
from app.llm import LLMError, _get_client as _get_gemini_client, _get_openai_client

logger = logging.getLogger("embeddings")

MAX_ATTEMPTS = 4  # for uploads/indexing: first try + 3 retries (2s, 4s, 8s)
QUERY_ATTEMPTS = 2  # for user questions: fail over to the other provider quickly


class EmbeddingError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class _Transient(Exception):
    """A failure worth retrying. Carries the error to raise if every retry fails."""

    def __init__(self, final: EmbeddingError):
        super().__init__(str(final))
        self.final = final


def _gemini_once(batch: list[str], task_type: str, model: str) -> list[list[float]]:
    try:
        client = _get_gemini_client()
    except LLMError as e:
        raise EmbeddingError(str(e), e.status_code)

    config = types.EmbedContentConfig(task_type=task_type, output_dimensionality=EMBEDDING_DIM)
    try:
        response = client.models.embed_content(model=model, contents=batch, config=config)
    except errors.APIError as e:
        code = getattr(e, "code", None)
        logger.warning("Gemini embedding failed: %s %s", code, e)
        if code in (401, 403):
            raise EmbeddingError("Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env.", 500)
        if code == 404:
            raise EmbeddingError("The Gemini embedding model was not found. Check GEMINI_EMBEDDING_MODEL.", 500)
        if code == 429:
            raise _Transient(EmbeddingError("Gemini embedding rate limit reached. Wait a minute and try again.", 429))
        if code in (500, 502, 503, 504):
            raise _Transient(EmbeddingError("Gemini is temporarily unavailable. Please try again.", 502))
        raise EmbeddingError("Could not create embeddings with Gemini. Please try again.", 502)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        logger.warning("Gemini embedding network error: %s", e)
        raise _Transient(EmbeddingError("Gemini took too long to respond while embedding.", 504))
    return [e.values for e in (response.embeddings or [])]


def _openai_once(batch: list[str], task_type: str, model: str) -> list[list[float]]:
    try:
        client = _get_openai_client()
    except LLMError as e:
        raise EmbeddingError(str(e), e.status_code)
    import openai

    try:
        response = client.embeddings.create(model=model, input=batch, dimensions=EMBEDDING_DIM)
    except (openai.AuthenticationError, openai.PermissionDeniedError):
        raise EmbeddingError("OpenAI rejected the API key. Check OPENAI_API_KEY in backend/.env.", 500)
    except openai.NotFoundError:
        raise EmbeddingError("The OpenAI embedding model was not found. Check OPENAI_EMBEDDING_MODEL.", 500)
    except openai.RateLimitError as e:
        if getattr(e, "code", None) == "insufficient_quota":
            raise EmbeddingError("The OpenAI account has no credit left. Check billing on platform.openai.com.", 402)
        raise _Transient(EmbeddingError("OpenAI embedding rate limit reached. Wait a minute and try again.", 429))
    except (openai.APITimeoutError, openai.APIConnectionError) as e:
        logger.warning("OpenAI embedding network error: %s", e)
        raise _Transient(EmbeddingError("OpenAI took too long to respond while embedding.", 504))
    except openai.InternalServerError:
        raise _Transient(EmbeddingError("OpenAI is temporarily unavailable. Please try again.", 502))
    except openai.APIStatusError as e:
        logger.warning("OpenAI embedding failed: %s %s", e.status_code, e)
        raise EmbeddingError("Could not create embeddings with OpenAI. Please try again.", 502)
    return [d.embedding for d in sorted(response.data, key=lambda d: d.index)]


_PROVIDERS = {"gemini": _gemini_once, "openai": _openai_once}


@traceable(name="embed_api_call", run_type="embedding", process_inputs=compact, process_outputs=compact)
def _embed_batch(batch: list[str], task_type: str, provider: str, attempts: int) -> list[list[float]]:
    once = _PROVIDERS[provider]
    model = EMBEDDING_MODELS[provider]
    delay = 1.0 if attempts <= 2 else 2.0
    for attempt in range(1, attempts + 1):
        try:
            vectors = once(batch, task_type, model)
        except _Transient as t:
            if attempt == attempts:
                raise t.final
            logger.warning("%s embedding attempt %d failed (%s), retrying in %.0fs", provider, attempt, t, delay)
            annotate(**{f"retry_{attempt}": f"{t} (slept {delay:.0f}s)"})
            time.sleep(delay)
            delay *= 2
            continue
        annotate(provider=provider, model=model, attempt=attempt, batch_size=len(batch))
        if len(vectors) != len(batch):
            raise EmbeddingError("The provider returned a different number of embeddings than requested.")
        return vectors
    raise EmbeddingError("Could not create embeddings. Please try again.", 502)


@traceable(name="embed", run_type="chain", process_inputs=compact, process_outputs=compact)
def _embed(texts: list[str], task_type: str, provider: str, attempts: int) -> np.ndarray:
    if provider not in _PROVIDERS:
        raise EmbeddingError(f"Unknown embedding provider '{provider}'.", 500)
    if not texts:
        return np.empty((0, EMBEDDING_DIM), dtype="float32")

    # Reuse vectors computed before; only call the API for texts we have never embedded.
    try:
        cached = cache.get_embeddings(provider, task_type, texts)
    except Exception as e:  # a cache problem must never break embedding
        logger.warning("Embedding cache read failed: %s", e)
        cached = {}
    missing_idx = [i for i in range(len(texts)) if i not in cached]
    missing = [texts[i] for i in missing_idx]
    annotate(provider=provider, task_type=task_type, cache_hits=len(cached), cache_misses=len(missing))

    rows: list[list[float]] = []
    for i in range(0, len(missing), EMBEDDING_BATCH_SIZE):
        rows.extend(_embed_batch(missing[i : i + EMBEDDING_BATCH_SIZE], task_type, provider, attempts))

    fresh = np.asarray(rows, dtype="float32").reshape(-1, EMBEDDING_DIM) if rows else np.empty((0, EMBEDDING_DIM), "float32")
    if fresh.shape != (len(missing), EMBEDDING_DIM):
        raise EmbeddingError(
            f"Expected embeddings of shape {(len(missing), EMBEDDING_DIM)} but got {fresh.shape}. "
            "Check EMBEDDING_DIM.", 500,
        )

    # Reduced sizes may not be unit length, and the FAISS indexes use inner product (cosine).
    norms = np.linalg.norm(fresh, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    fresh = fresh / norms

    if missing:
        try:
            cache.put_embeddings(provider, task_type, missing, fresh)
        except Exception as e:
            logger.warning("Embedding cache write failed: %s", e)
        if cached:
            logger.info("%s embeddings: %d cached, %d new", provider, len(cached), len(missing))

    vectors = np.empty((len(texts), EMBEDDING_DIM), dtype="float32")
    for i, v in cached.items():
        vectors[i] = v
    for j, i in enumerate(missing_idx):
        vectors[i] = fresh[j]
    return np.ascontiguousarray(vectors, dtype="float32")


def embed_texts(texts: list[str], provider: str | None = None, attempts: int = MAX_ATTEMPTS) -> np.ndarray:
    """Embed document chunks with one provider. Returns float32 (n, dim), unit length."""
    return _embed(texts, "RETRIEVAL_DOCUMENT", provider or EMBEDDING_PROVIDERS[0], attempts)


def embed_query(question: str, provider: str | None = None, attempts: int = QUERY_ATTEMPTS) -> np.ndarray:
    """Embed a user question with one provider. Returns float32 (1, dim), unit length."""
    return _embed([question], "RETRIEVAL_QUERY", provider or EMBEDDING_PROVIDERS[0], attempts)