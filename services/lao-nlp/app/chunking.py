"""Sentence-aware chunking.

Rules (CLAUDE.md / PROMPT.md):
  - never split mid-sentence — a bisected Lao sentence is unembeddable.
  - target max_tokens per chunk, with overlap_tokens of trailing sentences carried
    into the next chunk for retrieval continuity.
  - a single sentence longer than max_tokens is emitted whole (accept the long chunk).

Index-based sweep: each chunk is a contiguous run of sentences [start, end); the next
chunk's start steps back far enough to carry ~overlap_tokens of trailing sentences,
while always making forward progress.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import lao


@dataclass
class Chunk:
    seq: int
    text: str
    tokens: list[str]
    seg_text: str
    token_count: int
    n_sentences: int


def _emit(run: list[tuple[str, list[str]]], seq: int) -> Chunk:
    tokens: list[str] = []
    for _, tk in run:
        tokens.extend(tk)
    return Chunk(
        seq=seq,
        text=" ".join(s for s, _ in run),
        tokens=tokens,
        seg_text=" ".join(tokens),
        token_count=len(tokens),
        n_sentences=len(run),
    )


def chunk_text(text: str, max_tokens: int = 400, overlap_tokens: int = 60) -> list[Chunk]:
    if max_tokens <= 0:
        raise ValueError("max_tokens must be positive")
    if overlap_tokens < 0 or overlap_tokens >= max_tokens:
        raise ValueError("overlap_tokens must be in [0, max_tokens)")

    # Pre-tokenize each non-empty sentence once.
    counted = [(s, lao.word_tokens(s)) for s in lao.sentences(text) if s.strip()]
    n = len(counted)
    if n == 0:
        return []

    chunks: list[Chunk] = []
    seq = 0
    start = 0

    while start < n:
        end = start
        tok_sum = 0
        while end < n:
            cnt = len(counted[end][1])
            # Stop before overflow, but always take at least one sentence.
            if tok_sum + cnt > max_tokens and end > start:
                break
            tok_sum += cnt
            end += 1
            # A single sentence at/above the cap is emitted whole, alone.
            if cnt >= max_tokens:
                break

        chunks.append(_emit(counted[start:end], seq))
        seq += 1

        if end >= n:
            break

        # Next start: step back over trailing sentences up to overlap_tokens,
        # but never past `start` (guarantees forward progress).
        ov = 0
        ns = end
        while ns > start + 1 and ov < overlap_tokens:
            ns -= 1
            ov += len(counted[ns][1])
        start = ns if ns > start else end

    return chunks
