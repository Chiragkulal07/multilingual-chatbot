"""One FAISS index per embedding provider. Both indexes use the SAME vector ids (chunks.vector_id),
so a chunk found in either index maps to the same row in SQLite."""
import os
import threading
import time

import faiss
import numpy as np

from app.config import EMBEDDING_DIM, EMBEDDING_PROVIDERS, FAISS_INDEX_PATH

_lock = threading.RLock()
_indexes: dict = {}


def index_path(provider: str):
    return FAISS_INDEX_PATH.with_name(f"faiss_{provider}.index")


def _get_index(provider: str):
    index = _indexes.get(provider)
    if index is not None:
        return index
    path = index_path(provider)
    if path.exists():
        index = faiss.read_index(str(path))
        if index.d != EMBEDDING_DIM:
            raise RuntimeError(
                f"The saved {provider} index has {index.d} dimensions but EMBEDDING_DIM is "
                f"{EMBEDDING_DIM}. Delete {path} and restart to rebuild it."
            )
    else:
        # IndexIDMap lets us choose our own vector IDs and delete vectors later.
        # IndexFlatIP with normalized vectors = cosine similarity.
        index = faiss.IndexIDMap(faiss.IndexFlatIP(EMBEDDING_DIM))
    _indexes[provider] = index
    return index


def _save(provider: str, index) -> None:
    path = index_path(provider)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    faiss.write_index(index, str(tmp))
    for attempt in range(5):  # OneDrive can briefly lock files on Windows
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.3)


def add(provider: str, ids: list[int], vectors: np.ndarray) -> None:
    with _lock:
        index = _get_index(provider)
        index.add_with_ids(vectors, np.asarray(ids, dtype=np.int64))
        _save(provider, index)


def remove(provider: str, ids: list[int]) -> None:
    if not ids:
        return
    with _lock:
        index = _get_index(provider)
        index.remove_ids(np.asarray(ids, dtype=np.int64))
        _save(provider, index)


def remove_everywhere(ids: list[int]) -> None:
    """Remove these vector ids from every provider's index."""
    for provider in EMBEDDING_PROVIDERS:
        remove(provider, ids)


def search(provider: str, query_vector: np.ndarray, k: int) -> list[tuple[int, float]]:
    """Returns [(vector_id, similarity), ...] best first."""
    with _lock:
        index = _get_index(provider)
        if index.ntotal == 0:
            return []
        scores, ids = index.search(query_vector, min(k, index.ntotal))
    return [(int(i), float(s)) for i, s in zip(ids[0], scores[0]) if i != -1]


def all_ids(provider: str) -> set[int]:
    with _lock:
        index = _get_index(provider)
        return {int(i) for i in faiss.vector_to_array(index.id_map)}


def total(provider: str) -> int:
    with _lock:
        return _get_index(provider).ntotal


def reset(provider: str) -> None:
    """Forget one provider's index and delete its file (used when its model or size changes)."""
    with _lock:
        _indexes.pop(provider, None)
        index_path(provider).unlink(missing_ok=True)