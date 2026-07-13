"""Accept tracked changes before extraction.

Accounting docs from ministries are riddled with revisions. "Accept" = keep the
inserted text (w:ins, unwrapped) and drop the deleted text (w:del). Operates on the
raw OOXML tree (python-docx elements are lxml). Also resolves move revisions.
"""

from __future__ import annotations

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def accept_tracked_changes(element) -> dict:
    """Mutate `element` (a <w:document> lxml element) in place. Returns counts."""
    ins_count = _unwrap(element, f"{W}ins") + _unwrap(element, f"{W}moveTo")
    del_count = _remove(element, f"{W}del") + _remove(element, f"{W}moveFrom")
    return {"insertions_accepted": ins_count, "deletions_removed": del_count}


def _unwrap(root, tag: str) -> int:
    """Replace each matching element with its children (keep inserted content)."""
    count = 0
    # Materialize first: we mutate the tree while walking it.
    for el in list(root.iter(tag)):
        parent = el.getparent()
        if parent is None:
            continue
        idx = list(parent).index(el)
        for child in list(el):
            el.remove(child)
            parent.insert(idx, child)
            idx += 1
        parent.remove(el)
        count += 1
    return count


def _remove(root, tag: str) -> int:
    """Delete each matching element entirely (drop deleted content)."""
    count = 0
    # Materialize the list first: we mutate the tree while iterating.
    for el in list(root.iter(tag)):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
            count += 1
    return count
