"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@arnfar/ui/components/badge";
import { Button } from "@arnfar/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@arnfar/ui/components/dialog";
import { Input } from "@arnfar/ui/components/input";
import { Label } from "@arnfar/ui/components/label";
import { Select } from "@arnfar/ui/components/select";
import { Textarea } from "@arnfar/ui/components/textarea";

import {
  assignSplits,
  createQa,
  deleteQa,
  fetchQa,
  searchChunks,
  updateQa,
  verifyQa,
  type QaPair,
  type SearchHit,
} from "./api";

const SPLIT_VARIANT: Record<string, "default" | "secondary" | "muted" | "outline"> = {
  train: "default",
  dev: "secondary",
  test: "outline",
  unassigned: "muted",
};

/** Create/edit form. Citations are picked via hybrid search so the author never
 *  has to paste chunk UUIDs by hand. */
function QaFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: QaPair | null;
  onSaved: () => void;
}) {
  const [questionLo, setQuestionLo] = useState(initial?.questionLo ?? "");
  const [answerLo, setAnswerLo] = useState(initial?.answerLo ?? "");
  const [questionEn, setQuestionEn] = useState(initial?.questionEn ?? "");
  const [answerEn, setAnswerEn] = useState(initial?.answerEn ?? "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? 2);
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [citations, setCitations] = useState<{ id: string; label: string }[]>(
    (initial?.citationIds ?? []).map((id) => ({ id, label: id.slice(0, 8) })),
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    try {
      setHits(await searchChunks(query.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body = {
        questionLo: questionLo.trim(),
        answerLo: answerLo.trim(),
        ...(questionEn.trim() ? { questionEn: questionEn.trim() } : {}),
        ...(answerEn.trim() ? { answerEn: answerEn.trim() } : {}),
        citationIds: citations.map((c) => c.id),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        difficulty,
      };
      if (initial) await updateQa(initial.id, body);
      else await createQa(body);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit QA pair" : "New QA pair"}</DialogTitle>
          <DialogDescription>
            {initial
              ? "Editing resets verification — the pair must be re-verified before it exports."
              : "Every QA pair needs at least one citation to a non-rejected chunk."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="qa-q-lo">Question (Lao)</Label>
            <Textarea
              id="qa-q-lo"
              lang="lo"
              rows={2}
              value={questionLo}
              onChange={(e) => setQuestionLo(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="qa-a-lo">Answer (Lao)</Label>
            <Textarea
              id="qa-a-lo"
              lang="lo"
              rows={4}
              value={answerLo}
              onChange={(e) => setAnswerLo(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="qa-q-en">Question (English gloss, optional)</Label>
              <Input id="qa-q-en" value={questionEn} onChange={(e) => setQuestionEn(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="qa-a-en">Answer (English gloss, optional)</Label>
              <Input id="qa-a-en" value={answerEn} onChange={(e) => setAnswerEn(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="qa-difficulty">Difficulty</Label>
              <Select
                id="qa-difficulty"
                value={difficulty}
                onChange={(e) => setDifficulty(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="qa-tags">Tags (comma-separated)</Label>
              <Input id="qa-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vat, depreciation" />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Citations ({citations.length})</Label>
            {citations.length === 0 && (
              <p className="text-destructive text-xs">At least one citation is required.</p>
            )}
            <ul className="flex flex-wrap gap-1.5">
              {citations.map((c) => (
                <li key={c.id}>
                  <Badge variant="secondary" className="gap-1 font-mono">
                    {c.label}
                    <button
                      type="button"
                      aria-label={`remove citation ${c.label}`}
                      className="hover:text-destructive"
                      onClick={() => setCitations((cs) => cs.filter((x) => x.id !== c.id))}
                    >
                      ✕
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch();
                  }
                }}
                placeholder="search chunks to cite…"
              />
              <Button type="button" variant="outline" onClick={runSearch} disabled={searching}>
                {searching ? "Searching…" : "Search"}
              </Button>
            </div>
            {hits.length > 0 && (
              <ul className="divide-border max-h-48 divide-y overflow-y-auto rounded-lg border">
                {hits.map((h) => {
                  const added = citations.some((c) => c.id === h.id);
                  return (
                    <li key={h.id} className="flex items-start gap-2 p-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="text-muted-foreground truncate text-xs">
                          {h.title} · {h.kind}
                        </div>
                        <div lang="lo" className="line-clamp-2">
                          {h.content}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="xs"
                        variant={added ? "secondary" : "outline"}
                        disabled={added}
                        onClick={() =>
                          setCitations((cs) => [...cs, { id: h.id, label: h.id.slice(0, 8) }])
                        }
                      >
                        {added ? "Added" : "+ Cite"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || !questionLo.trim() || !answerLo.trim() || citations.length === 0}
          >
            {saving ? "Saving…" : initial ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QaClient() {
  const [qa, setQa] = useState<QaPair[]>([]);
  const [status, setStatus] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<QaPair | null>(null);
  const [deleting, setDeleting] = useState<QaPair | null>(null);

  const load = useCallback(() => {
    fetchQa().then(setQa).catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const verified = qa.filter((q) => q.verified).length;

  return (
    <main className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold">QA pairs</h2>
        <span className="text-muted-foreground text-sm">
          {verified}/{qa.length} verified
        </span>
        <Button
          className="ml-auto"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          New QA pair
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            const r = await assignSplits();
            setStatus(`splits: train ${r.train} · dev ${r.dev} · test ${r.test}`);
            load();
          }}
        >
          Assign splits (by document)
        </Button>
        <span className="text-muted-foreground text-sm">{status}</span>
      </div>

      {qa.length === 0 && (
        <p className="text-muted-foreground rounded-lg border p-6 text-center text-sm">
          No QA pairs yet — create one, or draft from a chunk in Review.
        </p>
      )}

      <ul className="divide-border divide-y rounded-lg border">
        {qa.map((q) => (
          <li key={q.id} className="p-3">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <Badge variant="muted">{q.source}</Badge>
              <Badge variant={SPLIT_VARIANT[q.split] ?? "muted"}>{q.split}</Badge>
              <span className="text-muted-foreground">cites {q.citationIds.length}</span>
              <span className="ml-auto flex items-center gap-1.5">
                {q.verified ? (
                  <Badge variant="secondary">● verified</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await verifyQa(q.id);
                      setStatus("verified qa");
                      load();
                    }}
                  >
                    Verify
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(q);
                    setFormOpen(true);
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeleting(q)}>
                  Delete
                </Button>
              </span>
            </div>
            <div lang="lo" className="font-medium">
              Q: {q.questionLo}
            </div>
            <div lang="lo" className="text-muted-foreground">
              A: {q.answerLo}
            </div>
            {q.citationIds.length === 0 && (
              <div className="text-destructive text-xs">⚠ no citations — cannot export</div>
            )}
          </li>
        ))}
      </ul>

      {formOpen && (
        <QaFormDialog
          key={editing?.id ?? "new"}
          open={formOpen}
          onOpenChange={setFormOpen}
          initial={editing}
          onSaved={() => {
            setStatus(editing ? "updated qa (re-verify to export)" : "created qa");
            load();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete QA pair?</DialogTitle>
            <DialogDescription lang="lo">{deleting?.questionLo}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleting) return;
                try {
                  await deleteQa(deleting.id);
                  setStatus("deleted qa");
                } catch (e) {
                  setStatus(`error: ${e instanceof Error ? e.message : e}`);
                }
                setDeleting(null);
                load();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
