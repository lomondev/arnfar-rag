"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@arnfar/ui/components/badge";
import { Button } from "@arnfar/ui/components/button";
import { Select } from "@arnfar/ui/components/select";
import { Textarea } from "@arnfar/ui/components/textarea";
import { cn } from "@arnfar/ui/lib/utils";

import {
  bulkAccept,
  fetchChunks,
  fetchDocuments,
  patchChunk,
  type Chunk,
  type DocItem,
  type ReviewState,
} from "./api";

const REVIEW_CLASS: Record<ReviewState, string> = {
  pending: "text-muted-foreground",
  accepted: "text-emerald-600 dark:text-emerald-400",
  edited: "text-blue-600 dark:text-blue-400",
  rejected: "text-destructive",
};

const KIND_VARIANT: Record<string, "default" | "secondary" | "muted" | "outline"> = {
  prose: "secondary",
  table: "default",
  account_row: "outline",
  list: "muted",
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

  // One save path for the Save button AND Ctrl+Enter — they must never drift apart.
  const saveEdit = useCallback(() => {
    const chunk = chunks.find((c) => c.id === editing);
    if (chunk && draft.trim()) void applyAction(chunk, "edit", draft);
    setEditing(null);
  }, [chunks, editing, draft, applyAction]);

  // Keyboard: j/k move, a accept, r reject, e edit; in edit Ctrl+Enter save, Esc cancel.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (editing) {
        if (ev.key === "Escape") {
          setEditing(null);
          ev.preventDefault();
        }
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          saveEdit();
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
  }, [chunks, cursor, editing, saveEdit, applyAction]);

  const current = chunks[cursor];
  const doc = docs.find((d) => d.id === docId);
  const counts = chunks.reduce<Record<string, number>>((acc, c) => {
    acc[c.review] = (acc[c.review] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <header className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <strong>Review</strong>
        <Select value={docId ?? ""} onChange={(e) => setDocId(e.target.value)}>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} · {d.collection} · {d.chunks} chunks ({d.pending} pending)
            </option>
          ))}
        </Select>
        <span className="text-muted-foreground text-xs">
          keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> accept · <kbd>e</kbd> edit ·{" "}
          <kbd>r</kbd> reject
        </span>
        {doc && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={async () => {
              const res = await bulkAccept(doc.id, { kind: "prose", minTokens: 20 });
              setStatus(`bulk accepted ${res.accepted} prose chunks (>20 tok)`);
              loadChunks(doc.id);
            }}
          >
            Bulk-accept prose &gt;20 tok
          </Button>
        )}
      </header>

      <div className="text-muted-foreground flex gap-4 px-4 py-1.5 text-xs">
        {Object.entries(counts).map(([k, n]) => (
          <span key={k} className={REVIEW_CLASS[k as ReviewState]}>
            ● {k}: {n}
          </span>
        ))}
        <span>{status}</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Chunk list */}
        <ul className="border-border w-[340px] overflow-y-auto border-r">
          {chunks.map((c, i) => (
            <li
              key={c.id}
              onClick={() => setCursor(i)}
              className={cn(
                "cursor-pointer border-b px-3 py-2",
                i === cursor ? "bg-accent" : "hover:bg-muted/40",
              )}
            >
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">#{c.seq}</span>
                <Badge variant={KIND_VARIANT[c.kind] ?? "secondary"}>{c.kind}</Badge>
                <span className="text-muted-foreground">{c.tokenCount}t</span>
                <span className={cn("ml-auto", REVIEW_CLASS[c.review])}>● {c.review}</span>
              </div>
              <div lang="lo" className="mt-1 truncate text-sm">
                {c.content.slice(0, 80)}
              </div>
            </li>
          ))}
        </ul>

        {/* Detail panel */}
        <section className="flex-1 overflow-y-auto px-6 py-4">
          {!current ? (
            <p className="text-muted-foreground">No chunks. Ingest a document first.</p>
          ) : editing === current.id ? (
            <div className="grid gap-2">
              <p className="text-muted-foreground text-sm">
                Editing #{current.seq} — ບັນທຶກແລ້ວ ຈະ segment + embed ຄືນ
              </p>
              <Textarea
                lang="lo"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-60 text-base"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={!draft.trim()} onClick={saveEdit}>
                  💾 ບັນທຶກ · Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  ຍົກເລີກ · Cancel
                </Button>
                <span className="text-muted-foreground ml-auto text-xs">
                  <kbd>Ctrl/⌘+Enter</kbd> save · <kbd>Esc</kbd> cancel
                </span>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-muted-foreground mb-2 text-sm">
                {current.headingPath.length ? current.headingPath.join(" › ") : "(no heading)"}
              </div>
              <div className="mb-3 flex items-center gap-2">
                <Button size="sm" onClick={() => applyAction(current, "accept")}>
                  ✓ Accept (a)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(current.content);
                    setEditing(current.id);
                  }}
                >
                  ✎ Edit (e)
                </Button>
                <Button size="sm" variant="destructive" onClick={() => applyAction(current, "reject")}>
                  ✗ Reject (r)
                </Button>
                <span
                  className={cn(
                    "ml-auto text-sm",
                    current.embedded ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                  )}
                >
                  {current.embedded ? "embedded" : "not embedded"}
                </span>
              </div>

              <h4 className="mt-2 mb-1 text-sm font-medium">content (original)</h4>
              <pre lang="lo" className="font-sans text-[1.05rem] whitespace-pre-wrap">
                {current.content}
              </pre>

              {current.content !== current.contentNorm && (
                <>
                  <h4 className="mt-4 mb-1 text-sm font-medium text-amber-600 dark:text-amber-400">
                    content_norm (normalization changed this)
                  </h4>
                  <pre lang="lo" className="text-muted-foreground font-sans text-sm whitespace-pre-wrap">
                    {current.contentNorm}
                  </pre>
                </>
              )}

              <h4 className="mt-4 mb-1 text-sm font-medium">content_seg (tsvector input)</h4>
              <pre lang="lo" className="text-muted-foreground font-sans text-xs whitespace-pre-wrap">
                {current.contentSeg}
              </pre>

              {Object.keys(current.meta).length > 0 && (
                <>
                  <h4 className="mt-4 mb-1 text-sm font-medium">meta</h4>
                  <pre className="bg-muted rounded p-2 text-xs">
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
