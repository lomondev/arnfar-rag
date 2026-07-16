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
import { Textarea } from "@arnfar/ui/components/textarea";

import {
  createTerm,
  deleteTerm,
  fetchTerms,
  mineGlossary,
  patchTerm,
  verifyTerm,
  type Term,
} from "./api";

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Add/edit a glossary term. termLo is fixed after creation (it is the unique key
 *  and drives segmentation); everything else is editable. */
function TermFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Term | null;
  onSaved: (msg: string) => void;
}) {
  const [termLo, setTermLo] = useState(initial?.termLo ?? "");
  const [termEn, setTermEn] = useState(
    initial && initial.termEn !== "(needs gloss)" ? initial.termEn : "",
  );
  const [definitionLo, setDefinitionLo] = useState(initial?.definitionLo ?? "");
  const [definitionEn, setDefinitionEn] = useState(initial?.definitionEn ?? "");
  const [variantsLo, setVariantsLo] = useState((initial?.variantsLo ?? []).join(", "));
  const [forbiddenLo, setForbiddenLo] = useState((initial?.forbiddenLo ?? []).join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (initial) {
        await patchTerm(initial.id, {
          termEn: termEn.trim(),
          definitionLo: definitionLo.trim(),
          definitionEn: definitionEn.trim(),
          variantsLo: splitList(variantsLo),
          forbiddenLo: splitList(forbiddenLo),
        });
        onSaved(`updated ${initial.termLo}`);
      } else {
        await createTerm({
          termLo: termLo.trim(),
          termEn: termEn.trim(),
          ...(definitionLo.trim() ? { definitionLo: definitionLo.trim() } : {}),
          ...(definitionEn.trim() ? { definitionEn: definitionEn.trim() } : {}),
          variantsLo: splitList(variantsLo),
          forbiddenLo: splitList(forbiddenLo),
        });
        onSaved(`added ${termLo.trim()}`);
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit term" : "Add term"}</DialogTitle>
          <DialogDescription>
            Lao stays Lao — the English gloss sits alongside, never instead.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="term-lo">Term (Lao)</Label>
            <Input
              id="term-lo"
              lang="lo"
              value={termLo}
              onChange={(e) => setTermLo(e.target.value)}
              disabled={initial !== null}
              className="text-base"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="term-en">English gloss</Label>
            <Input id="term-en" value={termEn} onChange={(e) => setTermEn(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="term-def-lo">Definition (Lao, optional)</Label>
            <Textarea
              id="term-def-lo"
              lang="lo"
              rows={2}
              value={definitionLo}
              onChange={(e) => setDefinitionLo(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="term-def-en">Definition (English, optional)</Label>
            <Textarea
              id="term-def-en"
              rows={2}
              value={definitionEn}
              onChange={(e) => setDefinitionEn(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="term-variants">Variants (Lao, comma-sep)</Label>
              <Input
                id="term-variants"
                lang="lo"
                value={variantsLo}
                onChange={(e) => setVariantsLo(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="term-forbidden">Forbidden (Lao, comma-sep)</Label>
              <Input
                id="term-forbidden"
                lang="lo"
                value={forbiddenLo}
                onChange={(e) => setForbiddenLo(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !termLo.trim() || !termEn.trim()}>
            {saving ? "Saving…" : initial ? "Save changes" : "Add term"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GlossaryClient() {
  const [terms, setTerms] = useState<Term[]>([]);
  const [status, setStatus] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Term | null>(null);
  const [deleting, setDeleting] = useState<Term | null>(null);

  const load = useCallback(() => {
    fetchTerms().then(setTerms).catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const verifiedCount = terms.filter((t) => t.verified).length;

  return (
    <main className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold">Glossary</h2>
        <span className="text-muted-foreground text-sm">
          {verifiedCount}/{terms.length} verified
        </span>
        <Button
          className="ml-auto"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          Add term
        </Button>
        <Button
          variant="outline"
          onClick={async () => {
            setStatus("mining…");
            const r = (await mineGlossary({ minFreq: 2, gloss: false })) as { created: unknown[] };
            setStatus(`mined ${r.created.length} candidates`);
            load();
          }}
        >
          Mine candidates
        </Button>
        <span className="text-muted-foreground text-sm">{status}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th className="p-2 font-medium">term_lo</th>
              <th className="p-2 font-medium">segmented</th>
              <th className="p-2 font-medium">term_en (gloss)</th>
              <th className="p-2 font-medium">status</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {terms.map((t) => (
              <tr key={t.id} className="hover:bg-muted/40 border-b last:border-0">
                <td lang="lo" className="p-2 text-base">
                  {t.termLo}
                  {(t.variantsLo.length > 0 || t.forbiddenLo.length > 0) && (
                    <span className="text-muted-foreground ml-1 text-xs">
                      {t.variantsLo.length > 0 && `+${t.variantsLo.length} variants`}
                      {t.forbiddenLo.length > 0 && ` ⛔${t.forbiddenLo.length}`}
                    </span>
                  )}
                </td>
                <td lang="lo" className="text-muted-foreground p-2">
                  {t.termLoSeg}
                </td>
                <td className="p-2">
                  <Input
                    defaultValue={t.termEn === "(needs gloss)" ? "" : t.termEn}
                    placeholder="english…"
                    className="w-40"
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  />
                </td>
                <td className="p-2">
                  {t.verified ? (
                    <Badge variant="secondary">● verified</Badge>
                  ) : (
                    <Badge variant="muted">○ draft</Badge>
                  )}
                </td>
                <td className="p-2">
                  <span className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={t.verified}
                      onClick={async () => {
                        const en = drafts[t.id] ?? t.termEn;
                        if (en && en !== t.termEn) await patchTerm(t.id, { termEn: en });
                        await verifyTerm(t.id);
                        setStatus(`verified ${t.termLo}`);
                        load();
                      }}
                    >
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(t);
                        setFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeleting(t)}>
                      Delete
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {terms.length === 0 && (
          <p className="text-muted-foreground p-6 text-center text-sm">
            No terms yet — add one manually or mine candidates from accepted chunks.
          </p>
        )}
      </div>

      {formOpen && (
        <TermFormDialog
          key={editing?.id ?? "new"}
          open={formOpen}
          onOpenChange={setFormOpen}
          initial={editing}
          onSaved={(msg) => {
            setStatus(msg);
            load();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete term?</DialogTitle>
            <DialogDescription lang="lo">{deleting?.termLo}</DialogDescription>
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
                  await deleteTerm(deleting.id);
                  setStatus(`deleted ${deleting.termLo}`);
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
