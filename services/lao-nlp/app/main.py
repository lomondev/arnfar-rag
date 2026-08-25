"""Lao NLP sidecar — FastAPI, :7731.

Segmentation is the trick that makes Lao lexical search work: Lao has no spaces
between words, so `seg_text` (LaoNLP tokens joined by single spaces) is what the
Postgres tsvector is built over. `content` stays pristine; the dense embedding uses
`content_norm` (from /normalize), never the segmented form.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from . import chunking, detect, lao, spell, textnorm
from . import rerank as rerank_mod
from .models import (
    ChunkOut,
    ChunkRequest,
    ChunkResponse,
    HealthResponse,
    NormalizeResponse,
    RerankHit,
    RerankRequest,
    RerankResponse,
    SegmentResponse,
    SpellcheckResponse,
    SpellToken,
    TextRequest,
)

app = FastAPI(title="arnfar-lao-nlp", version="1.0.0")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    caps = lao.capabilities()
    has_rerank = rerank_mod.available()
    return HealthResponse(
        status="ok",
        service="arnfar-lao-nlp",
        word_tokenize=caps["word_tokenize"],
        sent_tokenize=caps["sent_tokenize"],
        dictionary_size=caps["dictionary_size"],
        rerank=has_rerank,
        rerank_model=rerank_mod.model_name() if has_rerank else None,
    )


@app.post("/segment", response_model=SegmentResponse)
def segment(req: TextRequest) -> SegmentResponse:
    tokens = lao.word_tokens(req.text)
    return SegmentResponse(
        tokens=tokens,
        seg_text=" ".join(tokens),
        token_count=len(tokens),
        lang=detect.detect_lang(req.text),
    )


@app.post("/normalize", response_model=NormalizeResponse)
def normalize(req: TextRequest) -> NormalizeResponse:
    norm = textnorm.normalize(req.text)
    return NormalizeResponse(
        text=req.text,
        normalized=norm,
        zero_width_removed=textnorm.count_zero_width(req.text),
        lang=detect.detect_lang(req.text),
    )


@app.post("/chunk", response_model=ChunkResponse)
def chunk(req: ChunkRequest) -> ChunkResponse:
    chunks = chunking.chunk_text(req.text, req.max_tokens, req.overlap_tokens)
    return ChunkResponse(
        chunks=[
            ChunkOut(
                seq=c.seq,
                text=c.text,
                seg_text=c.seg_text,
                token_count=c.token_count,
                n_sentences=c.n_sentences,
            )
            for c in chunks
        ],
        total_chunks=len(chunks),
        lang=detect.detect_lang(req.text),
    )


@app.post("/spellcheck", response_model=SpellcheckResponse)
def spellcheck(req: TextRequest) -> SpellcheckResponse:
    results, unknown = spell.check_text(req.text)
    return SpellcheckResponse(
        tokens=[SpellToken(**r) for r in results],
        unknown_count=unknown,
        lang=detect.detect_lang(req.text),
    )


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    """Cross-encoder reranking. 503 on the default image — see app/rerank.py."""
    try:
        ranked = rerank_mod.rerank(req.query, req.documents, req.top_k)
    except RuntimeError as exc:
        # 503, not 500: the service is fine, this capability is simply not built in, and
        # the caller should fall back to the fused order rather than fail the query.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return RerankResponse(
        hits=[RerankHit(index=i, score=s) for i, s in ranked],
        model=rerank_mod.model_name(),
    )
