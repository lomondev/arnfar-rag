"""Route-level tests for the lao-nlp sidecar.

rag-api is the only caller, and it depends on the exact field names here — `seg_text`
feeding tsvector and `normalized` feeding the embedder are not interchangeable. A rename
on this side would degrade retrieval silently, so the response shape is asserted, not
assumed.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

ZWSP = "​"


def test_health_reports_capabilities() -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "arnfar-lao-nlp"
    assert isinstance(body["word_tokenize"], bool)


def test_segment_returns_tokens_and_seg_text() -> None:
    r = client.post("/segment", json={"text": "ບັນຊີການເງິນ"})
    assert r.status_code == 200
    body = r.json()
    assert body["token_count"] == len(body["tokens"])
    # seg_text is the tsvector input: tokens joined by spaces, never the embedder input.
    assert body["seg_text"] == " ".join(body["tokens"])


def test_segment_detects_lao() -> None:
    assert client.post("/segment", json={"text": "ອາກອນມູນຄ່າເພີ່ມ"}).json()["lang"] == "lo"


def test_normalize_strips_zero_width() -> None:
    r = client.post("/normalize", json={"text": f"ບັນຊີ{ZWSP}ການເງິນ"})
    body = r.json()
    assert body["normalized"] == "ບັນຊີການເງິນ"
    assert body["zero_width_removed"] == 1
    # The original must come back untouched — content is preserved byte-for-byte.
    assert body["text"] == f"ບັນຊີ{ZWSP}ການເງິນ"


def test_chunk_never_returns_an_empty_chunk() -> None:
    r = client.post("/chunk", json={"text": "ບັນຊີການເງິນ. " * 50})
    assert r.status_code == 200
    chunks = r.json()["chunks"]
    assert chunks
    assert all(c["text"].strip() for c in chunks)


def test_spellcheck_marks_non_lao_tokens_as_not_lao() -> None:
    r = client.post("/spellcheck", json={"text": "hello"})
    assert r.status_code == 200
    tokens = r.json()["tokens"]
    assert tokens
    assert all(t["is_lao"] is False for t in tokens)


def test_empty_text_is_handled_not_crashed() -> None:
    for path in ("/segment", "/normalize", "/spellcheck"):
        assert client.post(path, json={"text": ""}).status_code == 200


def test_health_reports_whether_reranking_is_built_in() -> None:
    r = client.get("/health")
    body = r.json()
    # Present on both images. rag-api reads this to decide whether the `hybrid-rrf+rerank`
    # arm is offerable, so its absence would silently disable the arm rather than explain it.
    assert isinstance(body["rerank"], bool)
    assert (body["rerank_model"] is None) is (body["rerank"] is False)


def test_rerank_is_503_not_500_when_the_model_is_not_installed() -> None:
    """The default image has no torch. That is a capability answer, not a crash.

    503 is what lets rag-api fall back to the fused RRF order instead of failing the query,
    so the status code is part of the contract and asserted here.
    """
    from app import rerank as rerank_mod

    r = client.post("/rerank", json={"query": "ອາກອນມູນຄ່າເພີ່ມ", "documents": ["ກ", "ຂ"]})
    if rerank_mod.available():
        assert r.status_code == 200
        body = r.json()
        assert [h["index"] for h in body["hits"]] == sorted(
            (h["index"] for h in body["hits"]),
            key=lambda i: -next(x["score"] for x in body["hits"] if x["index"] == i),
        )
        assert body["model"] == rerank_mod.model_name()
    else:
        assert r.status_code == 503
        assert "reranker not installed" in r.json()["detail"]


def test_rerank_rejects_a_nonsense_top_k() -> None:
    r = client.post("/rerank", json={"query": "ກ", "documents": ["ຂ"], "top_k": 0})
    assert r.status_code == 422
