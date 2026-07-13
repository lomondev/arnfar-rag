"""Table → cell matrix (+ Markdown), with correct merged-cell handling.

Merges are read from the OOXML grid (w:gridSpan for horizontal, w:vMerge for
vertical) — NOT by object identity. (id(cell._tc) is unreliable: lxml recycles
element proxies and their addresses, so id() collides across distinct cells and
blanks real data.) A merged region's value appears once, at its top-left; the
spanned positions are emitted as '' so a chart of accounts gets no phantom rows.
"""

from __future__ import annotations

from docx.oxml.ns import qn
from docx.table import Table


def _grid_span(tc) -> int:
    tcPr = tc.find(qn("w:tcPr"))
    if tcPr is None:
        return 1
    gs = tcPr.find(qn("w:gridSpan"))
    if gs is None:
        return 1
    try:
        return max(1, int(gs.get(qn("w:val")) or 1))
    except (TypeError, ValueError):
        return 1


def _vmerge(tc) -> str | None:
    """Return 'restart', 'continue', or None for a cell's vertical-merge state."""
    tcPr = tc.find(qn("w:tcPr"))
    if tcPr is None:
        return None
    vm = tcPr.find(qn("w:vMerge"))
    if vm is None:
        return None
    return "restart" if vm.get(qn("w:val")) == "restart" else "continue"


def _tc_text(tc) -> str:
    return _clean("".join(t.text or "" for t in tc.iter(qn("w:t"))))


def _clean(text: str) -> str:
    return " ".join(text.split()).strip()


def cell_matrix(table: Table) -> list[list[str]]:
    """Return the table as text rows; merged continuations are blanked to ''."""
    rows: list[list[str]] = []
    for tr in table._tbl.tr_lst:
        out_row: list[str] = []
        for tc in tr.tc_lst:
            span = _grid_span(tc)
            if _vmerge(tc) == "continue":
                out_row.extend([""] * span)  # continuation of a cell above
            else:
                out_row.append(_tc_text(tc))
                out_row.extend([""] * (span - 1))  # horizontal span filler
        rows.append(out_row)
    return rows


def to_markdown(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    n_cols = max(len(r) for r in rows)
    norm = [r + [""] * (n_cols - len(r)) for r in rows]

    def fmt(cells: list[str]) -> str:
        return "| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |"

    lines = [fmt(norm[0]), "| " + " | ".join(["---"] * n_cols) + " |"]
    for r in norm[1:]:
        lines.append(fmt(r))
    return "\n".join(lines)
