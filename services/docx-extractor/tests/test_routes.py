"""Route-level tests for the docx-extractor sidecar."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "arnfar-docx-extractor"
    assert body["python_docx"] is True


def test_extract_rejects_a_non_docx_upload() -> None:
    # A friendly 4xx, not a 500 traceback: this is reachable from the Studio's upload box.
    r = client.post("/extract", files={"file": ("notes.txt", b"not a docx", "text/plain")})
    assert r.status_code >= 400
    assert r.status_code < 500
