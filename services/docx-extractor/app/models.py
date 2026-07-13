"""Typed block stream + extract response models.

Accounting .docx files are structured, and that structure is the signal. Each block
is typed and carries the running heading_path so citations stay legible downstream.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


class HeadingBlock(BaseModel):
    type: Literal["heading"] = "heading"
    level: int
    text: str
    heading_path: list[str]


class ProseBlock(BaseModel):
    type: Literal["prose"] = "prose"
    text: str
    heading_path: list[str]
    amounts: list[str] = Field(default_factory=list)


class ListBlock(BaseModel):
    type: Literal["list"] = "list"
    text: str
    level: int
    ordered: bool | None
    heading_path: list[str]
    amounts: list[str] = Field(default_factory=list)


class TableBlock(BaseModel):
    type: Literal["table"] = "table"
    markdown: str
    cells: list[list[str]]
    n_rows: int
    n_cols: int
    heading_path: list[str]
    is_chart_of_accounts: bool = False
    coa_confidence: float = 0.0
    amounts: list[str] = Field(default_factory=list)


class AccountRowBlock(BaseModel):
    type: Literal["account_row"] = "account_row"
    code: str
    name_lo: str
    name_en: str | None = None
    parent_code: str | None = None
    account_class: str | None = None
    raw_row: list[str]
    heading_path: list[str]
    confidence: float


Block = Annotated[
    Union[HeadingBlock, ProseBlock, ListBlock, TableBlock, AccountRowBlock],
    Field(discriminator="type"),
]


class ExtractStats(BaseModel):
    n_blocks: int
    by_type: dict[str, int]
    n_amounts: int
    n_account_rows: int
    heading_paths: list[list[str]]
    footnotes: int


class ExtractResponse(BaseModel):
    blocks: list[Block]
    footnotes: list[str]
    stats: ExtractStats
    warnings: list[str]
