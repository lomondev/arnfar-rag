"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, FileUp, Loader2, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";

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
import { cn } from "@arnfar/ui/lib/utils";

import { useCollections } from "@/features/studio/useCollections";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

/* ── API shapes (mirror rag-api) ────────────────────────────────────────── */

interface LaoDefects {
  zeroWidth: number;
  doubledMarks: number;
  spaceBeforeMark: number;
  total: number;
  samples: string[];
}
interface ChunkPreview {
  seq: number;
  kind: string;
  tokenCount: number;
  headingPath: string[];
  excerpt: string;
  defects: LaoDefects | null;
  cleanedExcerpt: string | null;
}
interface PreviewResult {
  filename: string;
  blocks: number;
  chunks: ChunkPreview[];
  byKind: Record<string, number>;
  totalTokens: number;
  accountRows: number;
  defectTotals: { zeroWidth: number; doubledMarks: number; spaceBeforeMark: number; affectedChunks: number };
  warnings: string[];
}
interface DocRow {
  id: string;
  title: string;
  collection: string;
  status: string;
  lang: string;
  chunks: number;
  pending: number;
}
interface RetroReport {
  scanned: number;
  affected: number;
  byDefect: { zeroWidth: number; doubledMarks: number; spaceBeforeMark: number };
  fixed?: number;
  reembedJobs?: string[];
}
interface JobProgress {
  status: string;
  total: number;
  embedded: number;
}

const KIND_STYLE: Record<string, string> = {
  prose: "bg-secondary text-secondary-foreground",
  table: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  account_row: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  list: "bg-secondary text-secondary-foreground",
  heading: "bg-secondary text-secondary-foreground",
};

export function IngestClient() {
  const COLLECTIONS = useCollections();
  /* documents */
  const [docs, setDocs] = useState<readonly DocRow[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null);
  const [citedQa, setCitedQa] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* upload stepper */
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [collection, setCollection] = useState<string>("coa");
  const [title, setTitle] = useState("");
  const [authority, setAuthority] = useState("");
  const [committing, setCommitting] = useState(false);
  const [job, setJob] = useState<JobProgress | null>(null);
  const [showAllChunks, setShowAllChunks] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  /* retro-clean */
  const [scan, setScan] = useState<RetroReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixDone, setFixDone] = useState<RetroReport | null>(null);
  const [reembedPending, setReembedPending] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const refreshDocs = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/ingest/documents`);
      if (res.ok) setDocs((await res.json()) as DocRow[]);
    } catch {
      /* transient — next refresh wins */
    }
  }, []);

  useEffect(() => {
    void refreshDocs();
    return () => esRef.current?.close();
  }, [refreshDocs]);

  /* ── stage 1+2: pick file → dry-run preview (clean + chunk report) ── */
  async function runPreview(f: File) {
    setFile(f);
    // Suggest the filename as the knowledge title immediately — editable, and required
    // before commit. (Previously this only happened after a successful preview.)
    setTitle((cur) => cur || f.name.replace(/\.(docx|md|markdown)$/i, ""));
    setPreview(null);
    setJob(null);
    setError(null);
    setPreviewing(true);
    setShowAllChunks(false);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`${BASE}/ingest/preview`, { method: "POST", body: fd });
      const data = (await res.json()) as PreviewResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `preview failed (${res.status})`);
      setPreview(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  /* ── stage 3+4: commit (insert) → embed progress via SSE ── */
  async function commit() {
    if (!file) return;
    setCommitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("collection", collection);
      if (title) fd.append("title", title);
      if (authority) fd.append("authority", authority);
      const res = await fetch(`${BASE}/ingest/docx`, { method: "POST", body: fd });
      const data = (await res.json()) as { jobId?: string; deduped?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `ingest failed (${res.status})`);
      if (data.deduped) {
        setError("ເອກະສານນີ້ ມີຢູ່ແລ້ວ (duplicate sha256) — ບໍ່ນຳເຂົ້າຊ້ຳ");
        return;
      }
      void refreshDocs();
      if (data.jobId) {
        const es = new EventSource(`${BASE}/ingest/jobs/${data.jobId}/stream`);
        esRef.current = es;
        es.onmessage = (ev) => {
          const s = JSON.parse(ev.data) as JobProgress;
          setJob(s);
          if (s.status === "done" || s.status === "failed") {
            es.close();
            void refreshDocs();
          }
        };
        es.onerror = () => es.close();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  function resetUpload() {
    setFile(null);
    setPreview(null);
    setJob(null);
    setTitle("");
    setAuthority("");
    if (fileInput.current) fileInput.current.value = "";
  }

  /* ── documents: delete with cited-QA guard ── */
  async function doDelete(force: boolean) {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `${BASE}/ingest/documents/${deleteTarget.id}${force ? "?force=1" : ""}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { citedQa?: number; error?: string };
      if (res.status === 409) {
        setCitedQa(data.citedQa ?? 0); // show the warning, offer force
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `delete failed (${res.status})`);
      setDeleteTarget(null);
      setCitedQa(null);
      void refreshDocs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  /* ── retro-clean: scan → fix → watch re-embed drain ── */
  async function runScan() {
    setScanning(true);
    setFixDone(null);
    setError(null);
    try {
      const res = await fetch(`${BASE}/ingest/retro-clean`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      setScan((await res.json()) as RetroReport);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function runFix() {
    setFixing(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/ingest/retro-clean`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });
      const report = (await res.json()) as RetroReport;
      setFixDone(report);
      setScan(null);
      // Watch the re-embed queue drain via the documents endpoint's pending counts.
      const poll = window.setInterval(() => {
        void fetch(`${BASE}/ingest/documents`)
          .then((r) => r.json())
          .then((rows: DocRow[]) => {
            setDocs(rows);
            const pending = rows.reduce((a, d) => a + d.pending, 0);
            setReembedPending(pending);
            if (pending === 0) window.clearInterval(poll);
          })
          .catch(() => {});
      }, 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFixing(false);
    }
  }

  const chunksToShow = preview ? (showAllChunks ? preview.chunks : preview.chunks.slice(0, 6)) : [];
  const defectSamples = preview?.chunks.filter((c) => c.cleanedExcerpt).slice(0, 3) ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <h1 className="text-lg font-semibold">
        Ingest <span className="text-muted-foreground text-sm font-normal">ນຳເຂົ້າ · ທຳຄວາມສະອາດ · ຕັດຕອນ · embed</span>
      </h1>

      {error && (
        <p role="alert" className="border-destructive/40 bg-destructive/10 text-destructive mt-3 rounded-lg border px-3 py-2 text-sm">
          {error}
        </p>
      )}

      {/* ══ 1 · Upload & preview ══════════════════════════════════════ */}
      <section className="border-border bg-card mt-4 rounded-xl border p-5">
        <h2 className="text-sm font-semibold">1 · ອັບໂຫຼດ ແລະ ກວດກ່ອນ <span className="text-muted-foreground font-normal">upload &amp; preview (dry-run)</span></h2>

        {!file && (
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void runPreview(f);
            }}
            className={cn(
              "border-border text-muted-foreground mt-3 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-sm transition-colors",
              dragOver && "border-primary bg-primary/5 text-foreground",
            )}
          >
            <FileUp className="size-6" />
            <span lang="lo">ລາກໄຟລ໌ .docx ຫຼື .md ມາວາງ ຫຼື ກົດເລືອກ</span>
            <span className="text-xs">.docx / .md — ການກວດ ບໍ່ຂຽນຫຍັງລົງຖານຂໍ້ມູນ</span>
            <input
              ref={fileInput}
              type="file"
              accept=".docx,.md,.markdown"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void runPreview(f);
              }}
            />
          </label>
        )}

        {previewing && (
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> extracting → cleaning → chunking…
          </p>
        )}

        {/* Knowledge metadata — editable from the moment a file is chosen, not buried
            after the preview. Title is REQUIRED: it becomes the document title users
            see in Review, citations, and the Knowledge menus. */}
        {file && !job && (
          <div className="border-border bg-muted/30 mt-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label className="text-xs font-medium">ຫົວຂໍ້ຄວາມຮູ້ · knowledge title *</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="ເຊັ່ນ: ຄູ່ມືປິດບັນຊີທ້າຍປີ 2026"
                className="mt-1"
                lang="lo"
                autoFocus
              />
              <p className="text-muted-foreground mt-1 text-[0.7rem]">
                ຊື່ນີ້ຈະສະແດງໃນ Review, ແຫຼ່ງອ້າງອີງ ແລະ ໜ້າ Knowledge
              </p>
            </div>
            <div>
              <Label className="text-xs">collection</Label>
              <Select value={collection} onChange={(e) => setCollection(e.target.value)} className="mt-1">
                {COLLECTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs">authority (ອົງການອອກເອກະສານ)</Label>
              <Input value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="ກະຊວງການເງິນ…" className="mt-1" lang="lo" />
            </div>
          </div>
        )}

        {preview && (
          <div className="mt-4">
            {/* summary row */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{preview.filename}</span>
              <Badge variant="secondary">{preview.chunks.length} chunks</Badge>
              <Badge variant="secondary">{preview.totalTokens} tokens</Badge>
              {Object.entries(preview.byKind).map(([k, n]) => (
                <span key={k} className={cn("rounded-full px-2 py-0.5 text-xs font-medium", KIND_STYLE[k] ?? "bg-secondary")}>
                  {k}: {n}
                </span>
              ))}
              {preview.accountRows > 0 && (
                <Badge variant="secondary">CoA rows: {preview.accountRows}</Badge>
              )}
            </div>

            {/* clean report */}
            <div
              className={cn(
                "mt-3 rounded-lg border px-3 py-2.5 text-sm",
                preview.defectTotals.affectedChunks > 0
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-emerald-600/30 bg-emerald-500/10",
              )}
            >
              {preview.defectTotals.affectedChunks > 0 ? (
                <>
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="size-4" />
                    ພົບຂໍ້ບົກພ່ອງ Lao ໃນ {preview.defectTotals.affectedChunks} chunks — ຈະຖືກແກ້ໃນ content_norm/content_seg ອັດຕະໂນມັດ
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    zero-width: {preview.defectTotals.zeroWidth} · doubled marks: {preview.defectTotals.doubledMarks} · broken syllables: {preview.defectTotals.spaceBeforeMark} — ຕົ້ນສະບັບ (content) ບໍ່ຖືກແຕະຕ້ອງ
                  </p>
                  {defectSamples.map((c) => (
                    <div key={c.seq} className="border-border/60 mt-2 rounded-md border bg-background/60 px-2.5 py-1.5 text-xs">
                      <p lang="lo" className="text-destructive/80 line-through decoration-destructive/40">{c.excerpt.slice(0, 100)}</p>
                      <p lang="lo" className="text-emerald-700 dark:text-emerald-400">{c.cleanedExcerpt?.slice(0, 100)}</p>
                    </div>
                  ))}
                </>
              ) : (
                <p className="flex items-center gap-1.5 font-medium">
                  <Check className="size-4" /> ຂໍ້ຄວາມ Lao ສະອາດ — ບໍ່ພົບຂໍ້ບົກພ່ອງ
                </p>
              )}
            </div>

            {/* chunk boundaries */}
            <div className="mt-3">
              <p className="text-muted-foreground text-xs font-medium">ຂອບເຂດ chunks (ຕາຕະລາງ = ອັນດຽວ, ບໍ່ຕັດແຍກ):</p>
              <div className="mt-1.5 space-y-1.5">
                {chunksToShow.map((c) => (
                  <div key={c.seq} className="border-border flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                    <span className="text-muted-foreground w-6 shrink-0 text-right font-mono">{c.seq}</span>
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 font-medium", KIND_STYLE[c.kind] ?? "bg-secondary")}>{c.kind}</span>
                    <span className="text-muted-foreground shrink-0">{c.tokenCount}t</span>
                    {c.defects && <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />}
                    <span lang="lo" className="min-w-0 flex-1 truncate">{c.excerpt}</span>
                  </div>
                ))}
              </div>
              {preview.chunks.length > 6 && (
                <Button size="xs" variant="ghost" className="text-muted-foreground mt-1.5" onClick={() => setShowAllChunks((v) => !v)}>
                  {showAllChunks ? "ຫຍໍ້ລົງ" : `ເບິ່ງທັງໝົດ (${preview.chunks.length})`}
                </Button>
              )}
            </div>

            {/* commit — needs a completed preview AND a title */}
            {!job && (
              <div className="border-border mt-4 flex items-center gap-2 border-t pt-4">
                <Button
                  onClick={() => void commit()}
                  disabled={committing || !title.trim()}
                  title={!title.trim() ? "ໃສ່ຫົວຂໍ້ກ່ອນ · enter a title first" : undefined}
                  className="gap-1.5"
                >
                  {committing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  ນຳເຂົ້າ · commit &amp; embed
                </Button>
                {!title.trim() && (
                  <span lang="lo" className="text-xs text-amber-600">← ໃສ່ຫົວຂໍ້ຄວາມຮູ້ກ່ອນ ຈຶ່ງນຳເຂົ້າໄດ້</span>
                )}
                <Button variant="ghost" onClick={resetUpload} className="text-muted-foreground">ຍົກເລີກ</Button>
              </div>
            )}

            {/* embed progress */}
            {job && (
              <div className="border-border mt-4 border-t pt-4">
                <div className="flex items-center gap-2 text-sm">
                  {job.status === "done" ? (
                    <Check className="size-4 text-emerald-600" />
                  ) : job.status === "failed" ? (
                    <AlertTriangle className="text-destructive size-4" />
                  ) : (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  <span>
                    embedding {job.embedded}/{job.total} — {job.status}
                  </span>
                  {job.status === "done" && (
                    <Button size="xs" variant="ghost" onClick={resetUpload} className="text-muted-foreground ms-auto">
                      ນຳເຂົ້າໄຟລ໌ ຕໍ່ໄປ →
                    </Button>
                  )}
                </div>
                <div className="bg-secondary mt-2 h-2 overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full rounded-full transition-all"
                    style={{ width: `${job.total ? Math.round((job.embedded / job.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ══ 2 · Documents ═════════════════════════════════════════════ */}
      <section className="border-border bg-card mt-4 rounded-xl border p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">2 · ເອກະສານ <span className="text-muted-foreground font-normal">documents</span></h2>
          <Button size="xs" variant="ghost" onClick={() => void refreshDocs()} className="text-muted-foreground ms-auto gap-1">
            <RefreshCw className="size-3.5" /> refresh
          </Button>
        </div>
        {docs.length === 0 ? (
          <p lang="lo" className="text-muted-foreground mt-3 text-sm">ຍັງບໍ່ມີເອກະສານ — ອັບໂຫຼດຂ້າງເທິງ</p>
        ) : (
          <div className="mt-2 divide-y">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span lang="lo" className="min-w-0 flex-1 truncate font-medium" title={d.title}>{d.title}</span>
                <Badge variant="secondary">{d.collection}</Badge>
                <span className="text-muted-foreground w-20 text-right text-xs">{d.chunks} chunks</span>
                {d.pending > 0 ? (
                  <span className="flex items-center gap-1 text-xs text-amber-600">
                    <Loader2 className="size-3 animate-spin" /> {d.pending} embedding
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-emerald-600">
                    <Check className="size-3" /> embedded
                  </span>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Delete document"
                  onClick={() => { setDeleteTarget(d); setCitedQa(null); }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ══ 3 · Corpus cleaning (retro) ═══════════════════════════════ */}
      <section className="border-border bg-card mt-4 rounded-xl border p-5">
        <h2 className="text-sm font-semibold">3 · ທຳຄວາມສະອາດ corpus ເກົ່າ <span className="text-muted-foreground font-normal">retro-clean existing chunks</span></h2>
        <p lang="lo" className="text-muted-foreground mt-1 text-xs">
          ແກ້ ສະຫຼະຊ້ຳ / ພະຍາງຂາດ / zero-width ໃນ chunks ທີ່ນຳເຂົ້າກ່ອນມີດ່ານທຳຄວາມສະອາດ. ແກ້ສະເພາະ content_norm + content_seg ແລ້ວ embed ຄືນ — ຕົ້ນສະບັບບໍ່ຖືກແຕະ.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void runScan()} disabled={scanning} className="gap-1.5">
            {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            ສະແກນ · scan (dry-run)
          </Button>
          {scan && scan.affected > 0 && (
            <Button size="xs" onClick={() => void runFix()} disabled={fixing} className="gap-1.5">
              {fixing ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              ແກ້ໄຂ {scan.affected} chunks &amp; re-embed
            </Button>
          )}
        </div>
        {scan && (
          <p className="text-muted-foreground mt-2 text-sm">
            scanned {scan.scanned} · affected <span className={cn("font-medium", scan.affected > 0 ? "text-amber-600" : "text-emerald-600")}>{scan.affected}</span>
            {" — "}zero-width {scan.byDefect.zeroWidth} · doubled {scan.byDefect.doubledMarks} · broken {scan.byDefect.spaceBeforeMark}
          </p>
        )}
        {fixDone && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            <Check className="size-4" /> fixed {fixDone.fixed} chunks
            {reembedPending !== null && reembedPending > 0 && (
              <span className="text-muted-foreground flex items-center gap-1">
                — <Loader2 className="size-3.5 animate-spin" /> re-embedding, {reembedPending} left
              </span>
            )}
            {reembedPending === 0 && <span className="text-muted-foreground">— re-embed complete</span>}
          </p>
        )}
      </section>

      {/* ── delete confirm ── */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setCitedQa(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle lang="lo">ລຶບເອກະສານ?</DialogTitle>
            <DialogDescription lang="lo">
              {deleteTarget?.title} — {deleteTarget?.chunks} chunks ຈະຖືກລຶບຖາວອນ. ໄຟລ໌ຕົ້ນສະບັບໃນ storage ຍັງເກັບໄວ້.
            </DialogDescription>
          </DialogHeader>
          {citedQa !== null && citedQa > 0 && (
            <p className="border-amber-500/40 bg-amber-500/10 rounded-lg border px-3 py-2 text-sm">
              <AlertTriangle className="me-1.5 inline size-4 text-amber-600" />
              {citedQa} QA pair(s) cite chunks in this document — ລຶບແລ້ວ QA ເຫຼົ່ານັ້ນຈະ export ບໍ່ໄດ້.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setDeleteTarget(null); setCitedQa(null); }}>ຍົກເລີກ</Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void doDelete(citedQa !== null && citedQa > 0)}
              className="gap-1.5"
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {citedQa !== null && citedQa > 0 ? "ລຶບເຖິງແມ່ນ QA ຈະເສຍ" : "ລຶບ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
