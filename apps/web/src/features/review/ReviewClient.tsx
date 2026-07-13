"use client";

import { useCallback, useEffect, useState } from "react";

import {
  bulkAccept,
  fetchChunks,
  fetchDocuments,
  patchChunk,
  type Chunk,
  type DocItem,
  type ReviewState,
} from "./api";

const REVIEW_COLOR: Record<ReviewState, string> = {
  pending: "#9ca3af",
  accepted: "#16a34a",
  edited: "#2563eb",
  rejected: "#dc2626",
};

const KIND_BADGE: Record<string, string> = {
  prose: "#334155",
  table: "#7c3aed",
  account_row: "#b45309",
  list: "#0891b2",
};

export function ReviewClient() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [docId, setDocId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    fetchDocuments()
      .then((d) => {
        setDocs(d);
        if (d[0]) setDocId(d[0].id);
      })
      .catch((e) => setStatus(`error: ${e.message}`));
  }, []);

  const loadChunks = useCallback((id: string) => {
    fetchChunks(id)
      .then((c) => {
        setChunks(c);
        setCursor(0);
      })
      .catch((e) => setStatus(`error: ${e.message}`));
  }, []);

  useEffect(() => {
    if (docId) loadChunks(docId);
  }, [docId, loadChunks]);

  const applyAction = useCallback(
    async (chunk: Chunk, action: "accept" | "reject" | "edit", content?: string) => {
      try {
        await patchChunk(chunk.id, content ? { action, content } : { action });
        const next: ReviewState = action === "edit" ? "edited" : (`${action}ed` as ReviewState);
        setChunks((cs) =>
          cs.map((c) =>
            c.id === chunk.id
              ? { ...c, review: next, ...(content ? { content, embedded: false } : {}) }
              : c,
          ),
        );
        setStatus(`chunk #${chunk.seq} → ${next}`);
      } catch (e) {
        setStatus(`error: ${(e as Error).message}`);
      }
    },
    [],
  );

  // Keyboard: j/k move, a accept, r reject, e edit; in edit Ctrl+Enter save, Esc cancel.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (editing) {
        if (ev.key === "Escape") {
          setEditing(null);
          ev.preventDefault();
        }
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          const chunk = chunks.find((c) => c.id === editing);
          if (chunk) void applyAction(chunk, "edit", draft);
          setEditing(null);
          ev.preventDefault();
        }
        return;
      }
      const chunk = chunks[cursor];
      if (!chunk) return;
      if (ev.key === "j") setCursor((c) => Math.min(c + 1, chunks.length - 1));
      else if (ev.key === "k") setCursor((c) => Math.max(c - 1, 0));
      else if (ev.key === "a") void applyAction(chunk, "accept");
      else if (ev.key === "r") void applyAction(chunk, "reject");
      else if (ev.key === "e") {
        setDraft(chunk.content);
        setEditing(chunk.id);
      } else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chunks, cursor, editing, draft, applyAction]);

  const current = chunks[cursor];
  const doc = docs.find((d) => d.id === docId);
  const counts = chunks.reduce<Record<string, number>>((acc, c) => {
    acc[c.review] = (acc[c.review] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          padding: "0.6rem 1rem",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>Studio · Review</strong>
        <select
          value={docId ?? ""}
          onChange={(e) => setDocId(e.target.value)}
          style={{ padding: "0.25rem" }}
        >
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} · {d.collection} · {d.chunks} chunks ({d.pending} pending)
            </option>
          ))}
        </select>
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> accept · <kbd>e</kbd> edit ·{" "}
          <kbd>r</kbd> reject
        </span>
        {doc && (
          <button
            onClick={async () => {
              const res = await bulkAccept(doc.id, { kind: "prose", minTokens: 20 });
              setStatus(`bulk accepted ${res.accepted} prose chunks (>20 tok)`);
              loadChunks(doc.id);
            }}
            style={{ marginLeft: "auto" }}
          >
            Bulk-accept prose &gt;20 tok
          </button>
        )}
      </header>

      <div style={{ padding: "0.3rem 1rem", fontSize: "0.8rem", color: "#374151" }}>
        {Object.entries(counts).map(([k, n]) => (
          <span key={k} style={{ marginRight: "1rem", color: REVIEW_COLOR[k as ReviewState] }}>
            ● {k}: {n}
          </span>
        ))}
        <span style={{ color: "#6b7280" }}>{status}</span>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Chunk list */}
        <ul
          style={{
            width: 340,
            margin: 0,
            padding: 0,
            listStyle: "none",
            overflowY: "auto",
            borderRight: "1px solid #e5e7eb",
          }}
        >
          {chunks.map((c, i) => (
            <li
              key={c.id}
              onClick={() => setCursor(i)}
              style={{
                padding: "0.5rem 0.75rem",
                borderBottom: "1px solid #f1f5f9",
                background: i === cursor ? "#eff6ff" : "transparent",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.72rem" }}>
                <span style={{ color: "#94a3b8" }}>#{c.seq}</span>
                <span
                  style={{
                    background: KIND_BADGE[c.kind] ?? "#334155",
                    color: "white",
                    borderRadius: 4,
                    padding: "0 0.35rem",
                  }}
                >
                  {c.kind}
                </span>
                <span style={{ color: "#94a3b8" }}>{c.tokenCount}t</span>
                <span style={{ marginLeft: "auto", color: REVIEW_COLOR[c.review] }}>
                  ● {c.review}
                </span>
              </div>
              <div
                lang="lo"
                style={{
                  marginTop: 4,
                  fontSize: "0.85rem",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {c.content.slice(0, 80)}
              </div>
            </li>
          ))}
        </ul>

        {/* Detail panel */}
        <section style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
          {!current ? (
            <p style={{ color: "#6b7280" }}>No chunks. Ingest a document first.</p>
          ) : editing === current.id ? (
            <div>
              <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                Editing #{current.seq} — <kbd>Ctrl/⌘+Enter</kbd> save · <kbd>Esc</kbd> cancel
              </p>
              <textarea
                lang="lo"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ width: "100%", minHeight: 240, fontSize: "1rem", padding: "0.5rem" }}
              />
            </div>
          ) : (
            <div>
              <div style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: 8 }}>
                {current.headingPath.length ? current.headingPath.join(" › ") : "(no heading)"}
              </div>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <button onClick={() => applyAction(current, "accept")}>✓ Accept (a)</button>
                <button
                  onClick={() => {
                    setDraft(current.content);
                    setEditing(current.id);
                  }}
                >
                  ✎ Edit (e)
                </button>
                <button onClick={() => applyAction(current, "reject")}>✗ Reject (r)</button>
                <span style={{ marginLeft: "auto", color: current.embedded ? "#16a34a" : "#9ca3af" }}>
                  {current.embedded ? "embedded" : "not embedded"}
                </span>
              </div>

              <h4 style={{ margin: "0.5rem 0 0.25rem" }}>content (original)</h4>
              <pre
                lang="lo"
                style={{ whiteSpace: "pre-wrap", fontSize: "1.05rem", margin: 0, fontFamily: "inherit" }}
              >
                {current.content}
              </pre>

              {current.content !== current.contentNorm && (
                <>
                  <h4 style={{ margin: "1rem 0 0.25rem", color: "#b45309" }}>
                    content_norm (normalization changed this)
                  </h4>
                  <pre
                    lang="lo"
                    style={{ whiteSpace: "pre-wrap", fontSize: "0.95rem", margin: 0, fontFamily: "inherit", color: "#6b7280" }}
                  >
                    {current.contentNorm}
                  </pre>
                </>
              )}

              <h4 style={{ margin: "1rem 0 0.25rem" }}>content_seg (tsvector input)</h4>
              <pre
                lang="lo"
                style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", margin: 0, fontFamily: "inherit", color: "#475569" }}
              >
                {current.contentSeg}
              </pre>

              {Object.keys(current.meta).length > 0 && (
                <>
                  <h4 style={{ margin: "1rem 0 0.25rem" }}>meta</h4>
                  <pre style={{ fontSize: "0.8rem", background: "#f8fafc", padding: "0.5rem" }}>
                    {JSON.stringify(current.meta, null, 2)}
                  </pre>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
