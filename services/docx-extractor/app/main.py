"""docx-extractor sidecar — FastAPI, :7732.

POST /extract (multipart) → typed block stream + stats + warnings.
Pipeline per upload: [.doc → .docx via LibreOffice] → accept tracked changes →
walk body in order → typed blocks (+ chart-of-accounts rows) → footnotes to metadata.
"""

from __future__ import annotations

import tempfile
from collections import Counter
from pathlib import Path

import docx
from fastapi import FastAPI, File, HTTPException, UploadFile

from . import doc_convert, extractor, footnotes
from .models import ExtractResponse, ExtractStats
from .tracked_changes import accept_tracked_changes

app = FastAPI(title="arnfar-docx-extractor", version="1.0.0")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "arnfar-docx-extractor",
        "python_docx": True,
        "libreoffice": doc_convert.soffice_available(),
    }


@app.post("/extract", response_model=ExtractResponse)
async def extract(file: UploadFile = File(...)) -> ExtractResponse:
    name = file.filename or "upload"
    suffix = Path(name).suffix.lower()
    if suffix not in (".docx", ".doc"):
        raise HTTPException(status_code=422, detail=f"unsupported file type: {suffix or '?'}")

    data = await file.read()
    warnings: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        src = tmp_path / f"input{suffix}"
        src.write_bytes(data)

        if suffix == ".doc":
            if not doc_convert.soffice_available():
                raise HTTPException(
                    status_code=422,
                    detail="legacy .doc uploaded but LibreOffice is not installed",
                )
            try:
                src = doc_convert.convert_doc_to_docx(src, tmp_path / "converted")
                warnings.append("converted legacy .doc → .docx via LibreOffice")
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=422, detail=f"conversion failed: {exc}") from exc

        try:
            document = docx.Document(str(src))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"could not open document: {exc}") from exc

        # Accept tracked changes on the raw tree before extraction.
        tc = accept_tracked_changes(document.element)
        if tc["insertions_accepted"] or tc["deletions_removed"]:
            warnings.append(
                f"accepted {tc['insertions_accepted']} insertion(s), "
                f"removed {tc['deletions_removed']} deletion(s)"
            )

        blocks, extract_warnings = extractor.extract(document)
        warnings.extend(extract_warnings)
        notes = footnotes.read_notes(str(src))

    by_type = Counter(b.type for b in blocks)
    heading_paths = [b.heading_path for b in blocks if b.type == "heading"]
    n_amounts = sum(len(getattr(b, "amounts", []) or []) for b in blocks)

    stats = ExtractStats(
        n_blocks=len(blocks),
        by_type=dict(by_type),
        n_amounts=n_amounts,
        n_account_rows=by_type.get("account_row", 0),
        heading_paths=heading_paths,
        footnotes=len(notes),
    )
    return ExtractResponse(blocks=blocks, footnotes=notes, stats=stats, warnings=warnings)
