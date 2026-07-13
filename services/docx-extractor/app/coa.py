"""Chart-of-accounts table detection.

Heuristic (report confidence, never silently guess) — a table is a chart of
accounts when:
  - it has >= 3 columns, AND
  - some column is >= 80% numeric strings of length 3-6 (the account code), AND
  - some (different) column is >= 80% Lao script (the account name).

Every emitted account row is verified=false, always: extraction proposes, a human
disposes. name_en, parent_code, account_class are left for human curation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_CODE = re.compile(r"^[0-9໐-໙]{3,6}$")
_LAO = re.compile(r"[຀-໿]")
_LATIN = re.compile(r"[A-Za-z]")

MIN_COLS = 3
THRESHOLD = 0.80


@dataclass
class CoADetection:
    is_coa: bool
    confidence: float
    code_col: int = -1
    lao_col: int = -1
    en_col: int = -1
    header_row: int = 0
    rows: list[dict] = field(default_factory=list)  # {code, name_lo, name_en, raw_row}


def _columns(matrix: list[list[str]]) -> list[list[str]]:
    if not matrix:
        return []
    n_cols = max(len(r) for r in matrix)
    return [[(r[c] if c < len(r) else "") for r in matrix] for c in range(n_cols)]


def _ratio(cells: list[str], pred) -> float:
    vals = [c for c in cells if c.strip()]
    if not vals:
        return 0.0
    return sum(1 for c in vals if pred(c)) / len(vals)


def _is_code(cell: str) -> bool:
    return bool(_CODE.match(cell.strip()))


def _is_lao(cell: str) -> bool:
    lao = len(_LAO.findall(cell))
    latin = len(_LATIN.findall(cell))
    return lao > 0 and lao >= latin


def _is_en(cell: str) -> bool:
    lao = len(_LAO.findall(cell))
    latin = len(_LATIN.findall(cell))
    return latin > 0 and latin > lao


def detect(matrix: list[list[str]]) -> CoADetection:
    cols = _columns(matrix)
    if len(cols) < MIN_COLS or len(matrix) < 2:
        return CoADetection(is_coa=False, confidence=0.0)

    # Data rows only when scoring (skip a likely header row).
    has_header = _looks_like_header(matrix[0])
    body = matrix[1:] if has_header else matrix
    body_cols = _columns(body)

    code_scores = [(_ratio(col, _is_code), i) for i, col in enumerate(body_cols)]
    lao_scores = [(_ratio(col, _is_lao), i) for i, col in enumerate(body_cols)]
    code_ratio, code_col = max(code_scores)
    # Pick the best Lao column that is not the code column.
    lao_ratio, lao_col = max(
        ((r, i) for r, i in lao_scores if i != code_col), default=(0.0, -1)
    )

    if code_ratio < THRESHOLD or lao_ratio < THRESHOLD or lao_col < 0:
        return CoADetection(is_coa=False, confidence=min(code_ratio, lao_ratio))

    # Optional English gloss column: best latin column that is neither code nor lao.
    en_candidates = [
        (_ratio(col, _is_en), i)
        for i, col in enumerate(body_cols)
        if i not in (code_col, lao_col)
    ]
    en_ratio, en_col = max(en_candidates, default=(0.0, -1))
    if en_ratio < 0.5:
        en_col = -1

    rows: list[dict] = []
    for raw in body:
        code = (raw[code_col] if code_col < len(raw) else "").strip()
        name_lo = (raw[lao_col] if lao_col < len(raw) else "").strip()
        if not _is_code(code) or not name_lo:
            continue  # not a real account row (e.g. a sub-total / blank)
        name_en = (raw[en_col].strip() if 0 <= en_col < len(raw) else "") or None
        rows.append(
            {"code": code, "name_lo": name_lo, "name_en": name_en, "raw_row": raw}
        )

    return CoADetection(
        is_coa=len(rows) > 0,
        confidence=round(min(code_ratio, lao_ratio), 3),
        code_col=code_col,
        lao_col=lao_col,
        en_col=en_col,
        header_row=0 if has_header else -1,
        rows=rows,
    )


def _looks_like_header(row: list[str]) -> bool:
    """A header row has no account-code cell (labels, not data)."""
    return not any(_is_code(c) for c in row if c.strip())
