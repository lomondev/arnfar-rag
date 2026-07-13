"""Language detection by script census: Lao block vs Latin/ASCII."""

from __future__ import annotations

import re

_LAO = re.compile(r"[຀-໿]")
_LATIN = re.compile(r"[A-Za-z0-9]")


def detect_lang(text: str) -> str:
    """Return 'lo' | 'en' | 'mixed' from a character census."""
    lao = len(_LAO.findall(text))
    latin = len(_LATIN.findall(text))
    if lao == 0 and latin == 0:
        return "en"
    if latin == 0:
        return "lo"
    if lao == 0:
        return "en"
    ratio = lao / (lao + latin)
    if ratio >= 0.9:
        return "lo"
    if ratio <= 0.1:
        return "en"
    return "mixed"
