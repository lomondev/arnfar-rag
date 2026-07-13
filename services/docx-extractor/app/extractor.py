"""Walk a docx body in document order, emitting a typed block stream.

Document structure is the signal — we do not flatten to plain text. Headings build a
running heading_path; tables stay atomic and become Markdown; a table that looks like
a chart of accounts additionally yields one account_row per data row.
"""

from __future__ import annotations

import re

from docx.document import Document as _Document
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph

from . import coa
from .amounts import find_amounts
from .models import (
    AccountRowBlock,
    Block,
    HeadingBlock,
    ListBlock,
    ProseBlock,
    TableBlock,
)
from .tables import cell_matrix, to_markdown


def iter_block_items(document: _Document):
    """Yield Paragraph and Table objects in true document order."""
    body = document.element.body
    for child in body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, document)
        elif isinstance(child, CT_Tbl):
            yield Table(child, document)


def _heading_level(style_name: str | None) -> int | None:
    if not style_name:
        return None
    s = style_name.strip().lower()
    if s.startswith("heading"):
        m = re.search(r"(\d+)", s)
        return int(m.group(1)) if m else 1
    if s == "title":
        return 1
    return None


def _is_list(paragraph: Paragraph) -> tuple[bool, int]:
    p = paragraph._p
    pPr = p.pPr
    if pPr is not None and pPr.numPr is not None:
        ilvl = pPr.numPr.ilvl
        level = int(ilvl.val) if ilvl is not None and ilvl.val is not None else 0
        return True, level
    if (paragraph.style.name or "").strip().lower() == "list paragraph":
        return True, 0
    return False, 0


def _update_stack(stack: list[str], level: int, text: str) -> None:
    del stack[level - 1 :]
    while len(stack) < level - 1:
        stack.append("")
    stack.append(text)


def extract(document: _Document) -> tuple[list[Block], list[str]]:
    blocks: list[Block] = []
    warnings: list[str] = []
    stack: list[str] = []

    for item in iter_block_items(document):
        if isinstance(item, Table):
            _emit_table(item, list(stack), blocks, warnings)
            continue

        text = item.text.strip()
        style_name = item.style.name if item.style is not None else None
        level = _heading_level(style_name)

        if level is not None and text:
            _update_stack(stack, level, text)
            blocks.append(HeadingBlock(level=level, text=text, heading_path=list(stack)))
            continue

        if not text:
            continue  # empty paragraph — a layout artifact

        is_list, list_level = _is_list(item)
        if is_list:
            blocks.append(
                ListBlock(
                    text=text,
                    level=list_level,
                    ordered=None,
                    heading_path=list(stack),
                    amounts=find_amounts(text),
                )
            )
        else:
            blocks.append(
                ProseBlock(text=text, heading_path=list(stack), amounts=find_amounts(text))
            )

    return blocks, warnings


def _emit_table(
    table: Table, heading_path: list[str], blocks: list[Block], warnings: list[str]
) -> None:
    matrix = cell_matrix(table)
    if not matrix:
        return
    n_cols = max(len(r) for r in matrix)
    joined = "\n".join(" ".join(r) for r in matrix)
    det = coa.detect(matrix)

    blocks.append(
        TableBlock(
            markdown=to_markdown(matrix),
            cells=matrix,
            n_rows=len(matrix),
            n_cols=n_cols,
            heading_path=heading_path,
            is_chart_of_accounts=det.is_coa,
            coa_confidence=det.confidence,
            amounts=find_amounts(joined),
        )
    )

    if det.is_coa:
        for row in det.rows:
            blocks.append(
                AccountRowBlock(
                    code=row["code"],
                    name_lo=row["name_lo"],
                    name_en=row["name_en"],
                    parent_code=None,
                    account_class=None,
                    raw_row=row["raw_row"],
                    heading_path=heading_path,
                    confidence=det.confidence,
                )
            )
