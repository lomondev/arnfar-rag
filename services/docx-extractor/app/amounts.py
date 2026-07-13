"""Currency-literal detection.

Capture the LITERAL string of any monetary amount — never parse it to a number,
never round (CLAUDE.md: LAK is BIGINT + original literal, handled downstream).
Conservative on purpose: bare short integers like "3 columns" must not match.
"""

from __future__ import annotations

import re

# Lao and Arabic digits.
_D = r"0-9໐-໙"

# A grouped number (has a thousands separator), e.g. 1,000,000 or 1.000.000
_GROUPED = rf"[{_D}]{{1,3}}(?:[.,][{_D}]{{3}})+(?:[.,][{_D}]+)?"
# Any run of digits immediately tied to a currency marker.
_CURRENCY = r"(?:ກີບ|ກີບ|LAK|KIP|kip|Kip|₭)"
_WITH_CUR = rf"[{_D}]+(?:[.,][{_D}]+)*\s*{_CURRENCY}"
# A currency marker preceding digits, e.g. ₭ 1000
_CUR_FIRST = rf"{_CURRENCY}\s*[{_D}]+(?:[.,][{_D}]+)*"

_AMOUNT = re.compile(rf"(?:{_WITH_CUR}|{_CUR_FIRST}|{_GROUPED})")


def find_amounts(text: str) -> list[str]:
    """Return literal monetary strings found in text, in order, de-duplicated."""
    seen: set[str] = set()
    out: list[str] = []
    for m in _AMOUNT.finditer(text):
        lit = m.group(0).strip()
        if lit and lit not in seen:
            seen.add(lit)
            out.append(lit)
    return out
