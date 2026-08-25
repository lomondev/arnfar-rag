"""Pydantic request/response models for the lao-nlp API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    service: str
    word_tokenize: bool
    sent_tokenize: bool
    dictionary_size: int
    # False on the default (small) image, where /rerank answers 503. Reported so a caller
    # can tell "reranking is off" from "reranking is broken" without parsing an error.
    rerank: bool = False
    rerank_model: str | None = None


class TextRequest(BaseModel):
    text: str


class SegmentResponse(BaseModel):
    tokens: list[str]
    seg_text: str
    token_count: int
    lang: str


class NormalizeResponse(BaseModel):
    text: str
    normalized: str
    zero_width_removed: int
    lang: str


class ChunkRequest(BaseModel):
    text: str
    max_tokens: int = Field(default=400, gt=0, le=4000)
    overlap_tokens: int = Field(default=60, ge=0)


class ChunkOut(BaseModel):
    seq: int
    text: str
    seg_text: str
    token_count: int
    n_sentences: int


class ChunkResponse(BaseModel):
    chunks: list[ChunkOut]
    total_chunks: int
    lang: str


class SpellToken(BaseModel):
    token: str
    is_lao: bool
    in_dictionary: bool
    suggestions: list[str]


class SpellcheckResponse(BaseModel):
    tokens: list[SpellToken]
    unknown_count: int
    lang: str


class RerankRequest(BaseModel):
    query: str
    documents: list[str]
    # Rerank a wider net than you keep: the cross-encoder's whole job is to reorder
    # candidates the bi-encoder ranked badly, and it cannot promote what was never sent.
    top_k: int = Field(default=5, gt=0, le=200)


class RerankHit(BaseModel):
    # Index into the request's `documents`, not the text — the caller holds the chunk ids.
    index: int
    score: float


class RerankResponse(BaseModel):
    hits: list[RerankHit]
    model: str
