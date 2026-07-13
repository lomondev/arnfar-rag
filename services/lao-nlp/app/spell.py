"""Dictionary-membership spellcheck with edit-distance-1 suggestions.

Honest scope: this is spell-checking against LaoNLP's word list, not grammar
correction. Suggestions are the intersection of the token's edit-distance-1
neighbourhood with the spelling dictionary (Norvig's method, restricted to Lao
letters). Only Lao-script tokens are checked.
"""

from __future__ import annotations

import re

from . import lao

_HAS_LAO = re.compile(r"[຀-໿]")


def _edits1(word: str, letters: str) -> set[str]:
    splits = [(word[:i], word[i:]) for i in range(len(word) + 1)]
    deletes = [a + b[1:] for a, b in splits if b]
    transposes = [a + b[1] + b[0] + b[2:] for a, b in splits if len(b) > 1]
    replaces = [a + c + b[1:] for a, b in splits if b for c in letters]
    inserts = [a + c + b for a, b in splits for c in letters]
    return set(deletes + transposes + replaces + inserts)


def suggestions_for(word: str, limit: int = 5) -> list[str]:
    sd = lao.spelldict() or lao.dictionary()
    if not sd:
        return []
    cands = _edits1(word, lao.lao_letters()) & sd
    cands.discard(word)
    return sorted(cands)[:limit]


def check_token(token: str) -> dict:
    is_lao = bool(_HAS_LAO.search(token))
    if not is_lao:
        return {"token": token, "is_lao": False, "in_dictionary": True, "suggestions": []}
    known = token in lao.dictionary() or token in lao.spelldict()
    return {
        "token": token,
        "is_lao": True,
        "in_dictionary": known,
        "suggestions": [] if known else suggestions_for(token),
    }


def check_text(text: str) -> tuple[list[dict], int]:
    results = [check_token(t) for t in lao.word_tokens(text)]
    unknown = sum(1 for r in results if r["is_lao"] and not r["in_dictionary"])
    return results, unknown
