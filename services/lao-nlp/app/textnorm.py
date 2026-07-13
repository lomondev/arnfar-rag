"""Text normalization for Lao.

Original text is preserved elsewhere byte-for-byte (rag_chunk.content). This
produces `content_norm`: the dense-embedding input — NFC, zero-width characters
stripped, whitespace collapsed. Lao pasted out of Word is full of U+200B used as a
manual line-break hint; left in, it destroys tokenization and embedding.
"""

from __future__ import annotations

import re
import unicodedata

# Zero-width / invisible characters that corrupt Lao tokenization. U+200B and
# U+FEFF are the mandated ones; the rest are equally destructive when pasted.
_ZERO_WIDTH = {
    0x200B: None,  # ZERO WIDTH SPACE
    0x200C: None,  # ZERO WIDTH NON-JOINER
    0x200D: None,  # ZERO WIDTH JOINER
    0x2060: None,  # WORD JOINER
    0xFEFF: None,  # ZERO WIDTH NO-BREAK SPACE / BOM
}

_WHITESPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFC", text)
    t = t.translate(_ZERO_WIDTH)
    t = _WHITESPACE.sub(" ", t)
    return t.strip()


def count_zero_width(text: str) -> int:
    return sum(1 for ch in text if ord(ch) in _ZERO_WIDTH)
