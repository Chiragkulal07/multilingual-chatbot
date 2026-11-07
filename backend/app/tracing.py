"""LangSmith tracing. Turned on by LANGSMITH_TRACING=true plus LANGSMITH_API_KEY in backend/.env.

Without a key every helper here is a no-op, so the app runs exactly as before.
Each chat request / file upload becomes one trace in LangSmith, with child spans for
retrieval, embeddings, FAISS search, cache lookups, OCR and every LLM call (with token usage),
so you can see which step is slow."""
import logging
import os

logger = logging.getLogger("tracing")

# Accept the older LANGCHAIN_* names too.
for _new, _old in (
    ("LANGSMITH_API_KEY", "LANGCHAIN_API_KEY"),
    ("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"),
    ("LANGSMITH_PROJECT", "LANGCHAIN_PROJECT"),
):
    if not os.getenv(_new) and os.getenv(_old):
        os.environ[_new] = os.environ[_old]

_wanted = os.getenv("LANGSMITH_TRACING", "").strip().lower() in ("1", "true", "yes")
_has_key = bool(os.getenv("LANGSMITH_API_KEY", "").strip())
ENABLED = _wanted and _has_key

if _wanted and not _has_key:
    logger.warning("LANGSMITH_TRACING is on but LANGSMITH_API_KEY is empty; tracing disabled.")
# Tracing on without a key makes langsmith log upload errors on every call, so force it off.
os.environ["LANGSMITH_TRACING"] = "true" if ENABLED else "false"
os.environ.setdefault("LANGSMITH_PROJECT", "rag-ocr")

from langsmith import traceable  # noqa: E402  (must come after the env vars above)
from langsmith.run_helpers import get_current_run_tree  # noqa: E402

if ENABLED:
    print(f"[startup] LangSmith tracing ON (project: {os.environ['LANGSMITH_PROJECT']})", flush=True)


def wrap_gemini_client(client):
    """Gemini client whose generate/embed calls show up as LLM runs with token usage."""
    if not ENABLED:
        return client
    try:
        from langsmith.wrappers import wrap_gemini

        return wrap_gemini(client)
    except Exception as e:  # a tracing problem must never break the app
        logger.warning("Could not wrap the Gemini client for tracing: %s", e)
        return client


def wrap_openai_client(client):
    if not ENABLED:
        return client
    try:
        from langsmith.wrappers import wrap_openai

        return wrap_openai(client)
    except Exception as e:
        logger.warning("Could not wrap the OpenAI client for tracing: %s", e)
        return client


def _small(value):
    """Shrink big values (chunk lists, images, vectors) so traces stay light and readable."""
    try:
        import numpy as np

        if isinstance(value, np.ndarray):
            return f"<ndarray shape={value.shape} dtype={value.dtype}>"
    except Exception:
        pass
    if isinstance(value, str) and len(value) > 2000:
        return value[:2000] + f"... (+{len(value) - 2000} chars)"
    if isinstance(value, (list, tuple)) and value and all(isinstance(v, str) for v in value):
        return {"count": len(value), "total_chars": sum(map(len, value)), "first": _small(value[0])}
    if isinstance(value, dict):
        return {k: _small(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)) and len(value) > 20:
        return {"count": len(value), "first_items": [_small(v) for v in value[:3]]}
    return value


def compact(data) -> dict:
    """Use as process_inputs / process_outputs on traceable functions with large arguments.
    Inputs arrive as a dict of arguments; outputs arrive as the raw return value."""
    if isinstance(data, dict):
        return {k: _small(v) for k, v in data.items()}
    return {"output": _small(data)}


def annotate(**metadata) -> None:
    """Attach metadata (cache hit, scores, chosen provider...) to the current span."""
    if not ENABLED:
        return
    try:
        run = get_current_run_tree()
        if run is not None:
            run.add_metadata(metadata)
    except Exception:
        pass


__all__ = ["ENABLED", "traceable", "annotate", "compact", "wrap_gemini_client", "wrap_openai_client"]
