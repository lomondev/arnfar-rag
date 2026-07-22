"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Check, Landmark, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

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
import { cn } from "@arnfar/ui/lib/utils";

import { AccountsClient } from "@/features/dataset/AccountsClient";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";
const COLLECTIONS = ["lao-accounting-law", "coa", "tax", "sop", "lao-style"] as const;

interface Kind {
  id: string;
  key: string;
  nameLo: string;
  nameEn: string | null;
  description: string | null;
  collection: string;
  entries: number;
}
interface Entry {
  id: string;
  title: string;
  collection: string;
  updatedAt: string;
  chunks: number;
  pending: number;
  body: string;
}

/** Chart of Accounts stays available as a built-in kind — the lao_account system
 *  (verified workflow, export invariant, pipeline auto-extraction) is untouched. */
const COA_BUILTIN = "__coa__";

export function KnowledgeClient() {
  const [kinds, setKinds] = useState<readonly Kind[]>([]);
  const [selected, setSelected] = useState<string>(COA_BUILTIN);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* dialogs */
  const [kindDialog, setKindDialog] = useState(false);
  const [kindForm, setKindForm] = useState({ key: "", nameLo: "", nameEn: "", description: "", collection: "sop" });
  const [entryDialog, setEntryDialog] = useState<null | { id?: string; title: string; body: string }>(null);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const [citedQa, setCitedQa] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const loadKinds = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/knowledge/kinds`);
      if (res.ok) setKinds((await res.json()) as Kind[]);
    } catch {
      /* transient */
    }
  }, []);

  const loadEntries = useCallback(async (kindKey: string) => {
    if (kindKey === COA_BUILTIN) return;
    setLoadingEntries(true);
    try {
      const res = await fetch(`${BASE}/knowledge/entries?kind=${encodeURIComponent(kindKey)}`);
      if (res.ok) setEntries((await res.json()) as Entry[]);
    } catch {
      /* transient */
    } finally {
      setLoadingEntries(false);
    }
  }, []);

  useEffect(() => {
    void loadKinds();
  }, [loadKinds]);
  useEffect(() => {
    setEntries([]);
    void loadEntries(selected);
  }, [selected, loadEntries]);

  // While any entry is still embedding, poll so the badge flips to done.
  useEffect(() => {
    if (selected === COA_BUILTIN || entries.every((e) => e.pending === 0)) return;
    const t = window.setInterval(() => void loadEntries(selected), 2500);
    return () => window.clearInterval(t);
  }, [entries, selected, loadEntries]);

  async function saveKind() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/knowledge/kinds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: kindForm.key,
          nameLo: kindForm.nameLo,
          ...(kindForm.nameEn ? { nameEn: kindForm.nameEn } : {}),
          ...(kindForm.description ? { description: kindForm.description } : {}),
          collection: kindForm.collection,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `create failed (${res.status})`);
      setKindDialog(false);
      setKindForm({ key: "", nameLo: "", nameEn: "", description: "", collection: "sop" });
      await loadKinds();
      setSelected(kindForm.key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEntry() {
    if (!entryDialog) return;
    setBusy(true);
    setError(null);
    try {
      const res = entryDialog.id
        ? await fetch(`${BASE}/knowledge/entries/${entryDialog.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: entryDialog.title, body: entryDialog.body }),
          })
        : await fetch(`${BASE}/knowledge/entries`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kindKey: selected, title: entryDialog.title, body: entryDialog.body }),
          });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      setEntryDialog(null);
      await Promise.all([loadEntries(selected), loadKinds()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doDeleteEntry(force: boolean) {
    if (!deleteEntry) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/knowledge/entries/${deleteEntry.id}${force ? "?force=1" : ""}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { citedQa?: number; error?: string };
      if (res.status === 409) {
        setCitedQa(data.citedQa ?? 0);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `delete failed (${res.status})`);
      setDeleteEntry(null);
      setCitedQa(null);
      await Promise.all([loadEntries(selected), loadKinds()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const activeKind = kinds.find((k) => k.key === selected) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-6xl gap-5 px-6 py-6">
      {/* ── kinds rail ─────────────────────────────────────────────── */}
      <aside className="w-60 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-semibold">
            Knowledge <span lang="lo" className="text-muted-foreground font-normal">ຄວາມຮູ້</span>
          </h1>
          <Button size="icon-sm" variant="ghost" title="ສ້າງປະເພດໃໝ່ · new kind" onClick={() => setKindDialog(true)} className="text-muted-foreground">
            <Plus className="size-4" />
          </Button>
        </div>
        <nav className="mt-2 space-y-1">
          <button
            type="button"
            onClick={() => setSelected(COA_BUILTIN)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition-colors",
              selected === COA_BUILTIN ? "bg-secondary font-medium" : "hover:bg-muted text-muted-foreground",
            )}
          >
            <Landmark className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              ໝວດບັນຊີ <span className="text-muted-foreground text-xs">Chart of Accounts</span>
            </span>
          </button>
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setSelected(k.key)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition-colors",
                selected === k.key ? "bg-secondary font-medium" : "hover:bg-muted text-muted-foreground",
              )}
            >
              <BookOpen className="size-4 shrink-0" />
              <span lang="lo" className="min-w-0 flex-1 truncate" title={k.nameLo}>
                {k.nameLo}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">{k.entries}</span>
            </button>
          ))}
        </nav>
        {kinds.length === 0 && (
          <p lang="lo" className="text-muted-foreground mt-3 px-3 text-xs">
            ສ້າງປະເພດຄວາມຮູ້ຂອງທ່ານເອງ ດ້ວຍປຸ່ມ + — ເຊັ່ນ ອັດຕາອາກອນ, ຂັ້ນຕອນ, ນະໂຍບາຍ
          </p>
        )}
      </aside>

      {/* ── content ────────────────────────────────────────────────── */}
      <main className="min-w-0 flex-1">
        {error && (
          <p role="alert" className="border-destructive/40 bg-destructive/10 text-destructive mb-3 rounded-lg border px-3 py-2 text-sm">
            {error}
          </p>
        )}

        {selected === COA_BUILTIN ? (
          <AccountsClient />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0">
                <h2 lang="lo" className="truncate text-base font-semibold">
                  {activeKind?.nameLo ?? selected}
                  {activeKind?.nameEn && <span className="text-muted-foreground ms-2 text-sm font-normal">{activeKind.nameEn}</span>}
                </h2>
                {activeKind?.description && (
                  <p className="text-muted-foreground text-xs">{activeKind.description}</p>
                )}
              </div>
              <Badge variant="secondary" className="ms-auto">collection: {activeKind?.collection}</Badge>
              <Button size="xs" onClick={() => setEntryDialog({ title: "", body: "" })} className="gap-1.5">
                <Plus className="size-3.5" /> ເພີ່ມຄວາມຮູ້ · add
              </Button>
            </div>

            {loadingEntries ? (
              <p className="text-muted-foreground mt-6 flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> loading…
              </p>
            ) : entries.length === 0 ? (
              <div className="border-border mt-4 rounded-xl border border-dashed px-6 py-10 text-center">
                <p lang="lo" className="text-sm font-medium">ຍັງບໍ່ມີຄວາມຮູ້ໃນປະເພດນີ້</p>
                <p lang="lo" className="text-muted-foreground mt-1 text-xs">
                  ທຸກລາຍການທີ່ເພີ່ມ ຈະຖືກ ທຳຄວາມສະອາດ → ຕັດຕອນ → embed ໃຫ້ AI ຄົ້ນຫາ ແລະ ອ້າງອີງໄດ້ທັນທີ
                </p>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {entries.map((e) => (
                  <div key={e.id} className="border-border bg-card group rounded-xl border px-4 py-3">
                    <div className="flex items-center gap-2">
                      <p lang="lo" className="min-w-0 flex-1 truncate text-sm font-medium">{e.title}</p>
                      {e.pending > 0 ? (
                        <span className="flex items-center gap-1 text-xs text-amber-600">
                          <Loader2 className="size-3 animate-spin" /> embedding
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-emerald-600">
                          <Check className="size-3" /> ຄົ້ນຫາໄດ້
                        </span>
                      )}
                      <span className="text-muted-foreground text-xs">{e.chunks} chunk{e.chunks === 1 ? "" : "s"}</span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Edit"
                        onClick={() => setEntryDialog({ id: e.id, title: e.title, body: e.body })}
                        className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Delete"
                        onClick={() => { setDeleteEntry(e); setCitedQa(null); }}
                        className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <p lang="lo" className="text-muted-foreground mt-1 line-clamp-2 text-[0.85rem] leading-[1.7] whitespace-pre-wrap">
                      {e.body}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* ── new-kind dialog ── */}
      <Dialog open={kindDialog} onOpenChange={setKindDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle lang="lo">ສ້າງປະເພດຄວາມຮູ້ໃໝ່</DialogTitle>
            <DialogDescription lang="lo">
              ຕັ້ງຊື່ປະເພດ ຕາມທີ່ທີມຂອງທ່ານໃຊ້ — ອັດຕາອາກອນ, ຂັ້ນຕອນປິດບັນຊີ, ນະໂຍບາຍ, FAQ…
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">ຊື່ (ລາວ) *</Label>
                <Input lang="lo" value={kindForm.nameLo} onChange={(e) => setKindForm((f) => ({ ...f, nameLo: e.target.value }))} placeholder="ອັດຕາອາກອນ" className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Name (EN)</Label>
                <Input value={kindForm.nameEn} onChange={(e) => setKindForm((f) => ({ ...f, nameEn: e.target.value }))} placeholder="Tax rates" className="mt-1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">key (a-z, 0-9, -) *</Label>
                <Input value={kindForm.key} onChange={(e) => setKindForm((f) => ({ ...f, key: e.target.value.toLowerCase() }))} placeholder="tax-rates" className="mt-1 font-mono" />
              </div>
              <div>
                <Label className="text-xs">collection</Label>
                <Select value={kindForm.collection} onChange={(e) => setKindForm((f) => ({ ...f, collection: e.target.value }))} className="mt-1">
                  {COLLECTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">description</Label>
              <Input value={kindForm.description} onChange={(e) => setKindForm((f) => ({ ...f, description: e.target.value }))} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setKindDialog(false)}>ຍົກເລີກ</Button>
            <Button disabled={busy || !kindForm.key || !kindForm.nameLo} onClick={() => void saveKind()} className="gap-1.5">
              {busy && <Loader2 className="size-4 animate-spin" />} ສ້າງ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── entry dialog (create/edit) ── */}
      <Dialog open={entryDialog !== null} onOpenChange={(o) => { if (!o) setEntryDialog(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle lang="lo">{entryDialog?.id ? "ແກ້ໄຂຄວາມຮູ້" : "ເພີ່ມຄວາມຮູ້"}</DialogTitle>
            <DialogDescription lang="lo">
              ຂຽນເປັນພາສາລາວ — ລະບົບຈະ ທຳຄວາມສະອາດ, ຕັດຕອນ ແລະ embed ໃຫ້ AI ອ້າງອີງໄດ້.
              {entryDialog?.id && " ການແກ້ໄຂ ຈະສ້າງ chunks ໃໝ່ ແລະ embed ຄືນ."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label className="text-xs">ຫົວຂໍ້ *</Label>
              <Input lang="lo" value={entryDialog?.title ?? ""} onChange={(e) => setEntryDialog((d) => (d ? { ...d, title: e.target.value } : d))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">ເນື້ອໃນ *</Label>
              <Textarea
                lang="lo"
                rows={10}
                value={entryDialog?.body ?? ""}
                onChange={(e) => setEntryDialog((d) => (d ? { ...d, body: e.target.value } : d))}
                className="mt-1 text-[1rem] leading-[1.8]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEntryDialog(null)}>ຍົກເລີກ</Button>
            <Button
              disabled={busy || !entryDialog?.title.trim() || !entryDialog?.body.trim()}
              onClick={() => void saveEntry()}
              className="gap-1.5"
            >
              {busy && <Loader2 className="size-4 animate-spin" />} ບັນທຶກ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── delete entry confirm ── */}
      <Dialog open={deleteEntry !== null} onOpenChange={(o) => { if (!o) { setDeleteEntry(null); setCitedQa(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle lang="lo">ລຶບຄວາມຮູ້?</DialogTitle>
            <DialogDescription lang="lo">{deleteEntry?.title} — {deleteEntry?.chunks} chunk(s) ຈະຖືກລຶບ ແລະ AI ຈະບໍ່ເຫັນມັນອີກ.</DialogDescription>
          </DialogHeader>
          {citedQa !== null && citedQa > 0 && (
            <p className="border-amber-500/40 bg-amber-500/10 rounded-lg border px-3 py-2 text-sm">
              {citedQa} QA pair(s) cite this entry — ລຶບແລ້ວ QA ເຫຼົ່ານັ້ນ export ບໍ່ໄດ້.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setDeleteEntry(null); setCitedQa(null); }}>ຍົກເລີກ</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void doDeleteEntry(citedQa !== null && citedQa > 0)} className="gap-1.5">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {citedQa !== null && citedQa > 0 ? "ລຶບເຖິງແມ່ນ QA ຈະເສຍ" : "ລຶບ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
