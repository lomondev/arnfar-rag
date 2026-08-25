"""Cross-encoder reranking (CLAUDE.md phase-0 decision 4).

`bge-reranker-v2-m3` is the multilingual cross-encoder that pairs with `bge-m3`: same
family, same tokenizer, and it actually handles Lao. Where the bi-encoder scores a query
and a chunk independently and compares two vectors, the cross-encoder reads both together
and scores the pair — which is why it fixes exactly the failure RRF cannot, a chunk that
is topically near the question but does not answer it.

**Optional by construction.** torch + the model weights are ~2.5 GB, and every ingest in
this repo needs `/segment` while nothing yet needs `/rerank`. So the dependency is not in
`requirements.txt`: the base image stays small, `/rerank` answers 503 with the install
command until someone opts in, and `/health` says which of the two you are running. Build
the reranking image with:

    docker build --build-arg WITH_RERANKER=1 -t arnfar-lao-nlp:rerank ./services/lao-nlp

Runtime is offline once built — the weights are baked into the image and `HF_HUB_OFFLINE`
is set, so a boot with no network loads the same model rather than silently reaching for
huggingface.co (which CLAUDE.md forbids on the runtime path).
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any, Protocol

DEFAULT_MODEL = "BAAI/bge-reranker-v2-m3"

INSTALL_HINT = (
    "reranker not installed — rebuild the lao-nlp image with "
    "`docker build --build-arg WITH_RERANKER=1 ./services/lao-nlp`, "
    "or `pip install -r requirements-rerank.txt` in the container"
)


def model_name() -> str:
    return os.environ.get("RERANK_MODEL", DEFAULT_MODEL)


class _CrossEncoder(Protocol):
    """The one method used from sentence-transformers' CrossEncoder.

    Declared rather than imported: the real class only exists in the reranking build, and
    `predict` returns a numpy array, so the surface is pinned here instead of leaking Any
    through the module.
    """

    def predict(self, sentences: list[list[str]]) -> Any: ...


@lru_cache(maxsize=1)
def _load() -> _CrossEncoder | None:
    """Load the cross-encoder once, or return None when it is not installed.

    Cached including the failure: a missing dependency does not become available between
    two requests, and retrying the import on every call would put a multi-second failed
    import on the hot path of a health check.
    """
    try:
        from sentence_transformers import CrossEncoder
    except ImportError:
        return None
    # max_length caps the pair at the model's window. A 400-token Lao chunk plus a question
    # fits; a whole 400-token table plus a question can exceed it, and a silent truncation
    # of the *query* end would score the pair against half a question.
    model: _CrossEncoder = CrossEncoder(model_name(), max_length=1024)
    return model


def available() -> bool:
    """Whether /rerank can serve. Safe to call from /health."""
    return _load() is not None


def rerank(query: str, documents: list[str], top_k: int) -> list[tuple[int, float]]:
    """Score each document against the query; return (original_index, score), best first.

    Indices, not documents: the caller (rag-api) holds chunk ids alongside the text it
    sent, and returning the text back would make it re-match strings — Lao text with
    combining marks is exactly the wrong thing to use as a join key.

    Raises RuntimeError when the model is not installed; the route maps that to 503.
    """
    model = _load()
    if model is None:
        raise RuntimeError(INSTALL_HINT)
    if not documents:
        return []

    scores = model.predict([[query, doc] for doc in documents])
    ranked = sorted(enumerate(float(s) for s in scores), key=lambda p: p[1], reverse=True)
    return ranked[:top_k] if top_k > 0 else ranked
