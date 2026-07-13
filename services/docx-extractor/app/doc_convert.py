"""Legacy .doc → .docx conversion via LibreOffice (headless).

python-docx cannot read the old binary .doc format, so we shell out to soffice.
If LibreOffice is not installed the caller gets a clear error rather than a crash.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def soffice_bin() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def soffice_available() -> bool:
    return soffice_bin() is not None


def convert_doc_to_docx(src: Path, out_dir: Path) -> Path:
    binary = soffice_bin()
    if binary is None:
        raise RuntimeError(
            "LibreOffice (soffice) is not installed; cannot convert legacy .doc files"
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [binary, "--headless", "--convert-to", "docx", "--outdir", str(out_dir), str(src)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"soffice conversion failed: {proc.stderr.strip()}")
    converted = out_dir / (src.stem + ".docx")
    if not converted.exists():
        raise RuntimeError("soffice reported success but no .docx was produced")
    return converted
