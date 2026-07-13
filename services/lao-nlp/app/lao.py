"""Defensive LaoNLP loader.

LaoNLP's export surface has moved between releases, so every import is guarded.
If tokenization is unavailable we fall back to whitespace splitting and report the
degraded capability from /health — the service must never crash on import.
"""

from __future__ import annotations

from typing import Callable

# ── capability flags, resolved once at import ────────────────────────────────
_word_tokenize: Callable[[str], list[str]] | None = None
_sent_tokenize: Callable[[str], list[str]] | None = None
_dictionary: set[str] = set()
_spelldict: set[str] = set()

# Lao letters used to generate spelling edits. Fallback covers the full block if
# LaoNLP's constants are absent.
_LAO_LETTERS_FALLBACK = (
    "ກຂຄງຈສຊຍດຕຖທນບປຜຝພຟມຢຣລວຫອຮ"  # consonants
    "ະັາຳິີຶືຸູົຼຽເແໂໃໄໍ"  # vowels
    "່້໊໋໌"  # tone marks + cancellation
)
_lao_letters: str = _LAO_LETTERS_FALLBACK


def _load() -> None:
    global _word_tokenize, _sent_tokenize, _dictionary, _spelldict, _lao_letters

    try:
        from laonlp.tokenize import word_tokenize, sent_tokenize

        _word_tokenize = word_tokenize
        _sent_tokenize = sent_tokenize
    except Exception:  # noqa: BLE001 — degrade, never crash
        _word_tokenize = None
        _sent_tokenize = None

    try:
        from laonlp.corpus import lao_words, lao_spellcheckdict

        _dictionary = {w for w in lao_words() if w}
        _spelldict = {w for w in lao_spellcheckdict() if w}
    except Exception:  # noqa: BLE001
        _dictionary = set()
        _spelldict = set()

    try:
        from laonlp import CONSONANTS, VOWELS, TONE_MARKS

        letters = f"{CONSONANTS}{VOWELS}{TONE_MARKS}"
        # De-duplicate while keeping only Lao-block characters.
        _lao_letters = "".join(sorted({c for c in letters if "຀" <= c <= "໿"}))
    except Exception:  # noqa: BLE001
        _lao_letters = _LAO_LETTERS_FALLBACK


_load()


def capabilities() -> dict:
    return {
        "word_tokenize": _word_tokenize is not None,
        "sent_tokenize": _sent_tokenize is not None,
        "dictionary_size": len(_dictionary),
        "spelldict_size": len(_spelldict),
    }


def dictionary() -> set[str]:
    return _dictionary


def spelldict() -> set[str]:
    return _spelldict


def lao_letters() -> str:
    return _lao_letters


def word_tokens(text: str) -> list[str]:
    """Word tokens with pure-whitespace tokens dropped.

    LaoNLP returns spaces/newlines as their own tokens for mixed text; we drop
    those so `seg_text` and token_count reflect real words only.
    """
    if _word_tokenize is None:
        # Degraded fallback: Lao has no spaces, so this yields coarse tokens.
        return [t for t in text.split() if t.strip()]
    return [t for t in _word_tokenize(text) if t.strip()]


def sentences(text: str) -> list[str]:
    """Sentence split. Falls back to a punctuation/newline heuristic."""
    if _sent_tokenize is not None:
        parts = [s.strip() for s in _sent_tokenize(text)]
        return [s for s in parts if s]
    return _fallback_sentences(text)


_SENT_ENDERS = ".!?ฯ\n"  # incl. Lao ellipsis-like ໆ handled elsewhere; newline splits


def _fallback_sentences(text: str) -> list[str]:
    out: list[str] = []
    buf: list[str] = []
    for ch in text:
        buf.append(ch)
        if ch in _SENT_ENDERS:
            s = "".join(buf).strip()
            if s:
                out.append(s)
            buf = []
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out
