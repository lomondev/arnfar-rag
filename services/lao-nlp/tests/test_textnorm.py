"""content_norm is the dense-embedding input.

CLAUDE.md is explicit that `content` stays byte-for-byte original and normalization
lives in a separate column. What matters here is that normalize() removes exactly the
invisibles that corrupt Lao tokenization and changes nothing else — a normalizer that
also rewrites Lao characters would silently degrade every embedding in the corpus.
"""

from __future__ import annotations

import unicodedata

from app.textnorm import count_zero_width, normalize

ZWSP = "​"
BOM = "﻿"


def test_strips_zero_width_space() -> None:
    assert normalize(f"ບັນຊີ{ZWSP}ການເງິນ") == "ບັນຊີການເງິນ"


def test_strips_every_invisible_variant() -> None:
    dirty = f"a{ZWSP}b‌c‍d⁠e{BOM}f"
    assert normalize(dirty) == "abcdef"


def test_collapses_whitespace_runs() -> None:
    assert normalize("ບັນຊີ   \n\t ການເງິນ") == "ບັນຊີ ການເງິນ"


def test_trims_edges() -> None:
    assert normalize("  ບັນຊີ  ") == "ບັນຊີ"


def test_applies_nfc_composition() -> None:
    decomposed = unicodedata.normalize("NFD", "é")
    assert normalize(decomposed) == "é"
    assert len(normalize(decomposed)) == 1


def test_leaves_clean_lao_unchanged() -> None:
    clean = "ອາກອນມູນຄ່າເພີ່ມ"
    assert normalize(clean) == clean


def test_preserves_lao_tone_marks() -> None:
    # The one thing normalization must never do is alter Lao composition.
    text = "ຄ່າ ເສື່ອມ ລາຄາ"
    assert normalize(text) == text


def test_is_idempotent() -> None:
    once = normalize(f"  ບັນຊີ{ZWSP}  ການເງິນ ")
    assert normalize(once) == once


def test_empty_string() -> None:
    assert normalize("") == ""


def test_count_zero_width() -> None:
    assert count_zero_width(f"a{ZWSP}b{BOM}c") == 2
    assert count_zero_width("ບັນຊີ") == 0
