"""Extract footnotes/endnotes into metadata — never inline them into content.

Footnote text inlined into a paragraph poisons the embedding, so we pull it out
separately. Read directly from the OOXML parts (python-docx doesn't surface them).
"""

from __future__ import annotations

import zipfile

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
# id 0 and -1 are the separator / continuation-separator notes, not real content.
_SKIP_IDS = {"0", "-1"}


def read_notes(path: str) -> list[str]:
    out: list[str] = []
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return out
    with zf:
        for part, tag in (("word/footnotes.xml", "footnote"), ("word/endnotes.xml", "endnote")):
            if part not in zf.namelist():
                continue
            out.extend(_parse_notes(zf.read(part), tag))
    return out


def _parse_notes(xml_bytes: bytes, tag: str) -> list[str]:
    from lxml import etree

    root = etree.fromstring(xml_bytes)
    notes: list[str] = []
    for note in root.iter(f"{W}{tag}"):
        note_id = note.get(f"{W}id")
        if note_id in _SKIP_IDS:
            continue
        text = "".join(t.text or "" for t in note.iter(f"{W}t")).strip()
        if text:
            notes.append(text)
    return notes
