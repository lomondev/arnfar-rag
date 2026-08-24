"""Monetary literals are captured, never parsed.

CLAUDE.md: an extracted amount is stored as BIGINT LAK *plus the original literal*, and
the extractor's job is only the literal. These tests pin both halves of that contract —
the literal comes back exactly as written, and the detector stays conservative enough
that a bare integer in prose is not mistaken for money.
"""

from __future__ import annotations

from app.amounts import find_amounts


def test_finds_grouped_number() -> None:
    assert find_amounts("ລວມ 1,000,000 ກີບ") == ["1,000,000 ກີບ"]


def test_finds_amount_with_lao_currency_word() -> None:
    assert find_amounts("ລາຄາ 500 ກີບ") == ["500 ກີບ"]


def test_finds_amount_with_latin_currency_code() -> None:
    assert find_amounts("total 250000 LAK") == ["250000 LAK"]


def test_finds_currency_symbol_first() -> None:
    assert find_amounts("₭ 1000") == ["₭ 1000"]


def test_finds_lao_digits() -> None:
    found = find_amounts("ລວມ ໑,໐໐໐,໐໐໐ ກີບ")
    assert found and "໑" in found[0]


def test_preserves_the_literal_exactly() -> None:
    # Not 1000000, not 1_000_000 — the string as the document wrote it.
    assert find_amounts("ຍອດ 1.000.000 ກີບ")[0] == "1.000.000 ກີບ"


def test_ignores_a_bare_small_integer() -> None:
    # "3 columns" is not money; a detector that matched it would flood every chunk
    # with phantom amounts.
    assert find_amounts("ມີ 3 ຖັນ") == []


def test_returns_multiple_amounts_in_order() -> None:
    assert find_amounts("ຫັກ 100,000 ກີບ ແລະ 250,000 ກີບ") == ["100,000 ກີບ", "250,000 ກີບ"]


def test_deduplicates_repeats() -> None:
    assert find_amounts("100,000 ກີບ ... 100,000 ກີບ") == ["100,000 ກີບ"]


def test_no_amounts_in_plain_prose() -> None:
    assert find_amounts("ບົດບັນຊີການເງິນ") == []


def test_empty_text() -> None:
    assert find_amounts("") == []
