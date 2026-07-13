"""Pydantic request/response models for the lao-nlp API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    service: str
    word_tokenize: bool
    sent_tokenize: bool
    dictionary_size: int


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
