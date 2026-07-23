"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, FileUp, GraduationCap, MessageCircleQuestion, RefreshCw } from "lucide-react";

import { Badge } from "@arnfar/ui/components/badge";
import { Button } from "@arnfar/ui/components/button";
import { cn } from "@arnfar/ui/lib/utils";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

interface Overview {
  corpus: {
    documents: number;
    chunks: number;
    embedded: number;
    review: { pending: number; accepted: number; rejected: number };
    byCollection: { collection: string; chunks: number; accepted: number }[];
    avgTokens: number;
  };
  dataset: {
    qa: { total: number; verified: number };
    terms: { total: number; verified: number };
    accounts: { total: number; verified: number };
  };
  chat: { conversations: number; messages: number };
  activity: { eventType: string; createdAt: string; summary: string }[];
}
interface Gaps {
  abstained: { question: string; answer: string; conversationId: string; at: string }[];
  reported: { id: string; excerpt: string; collection: string; title: string }[];
}

function Stat({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = (
    <div className="border-border bg-card hover:border-ring/40 rounded-xl border p-4 transition-colors">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-muted-foreground mt-0.5 text-xs">{sub}</p>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function DashboardClient() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    void fetch(`${BASE}/dashboard/overview`).then((r) => r.json()).then(setOv).catch((e) => setError(String(e)));
    void fetch(`${BASE}/dashboard/gaps`).then((r) => r.json()).then(setGaps).catch(() => {});
  };
  useEffect(load, []);

  if (error) {
    return <p className="text-destructive p-6 text-sm">rag-api unreachable: {error}</p>;
  }
  if (!ov) {
    return <p className="text-muted-foreground p-6 text-sm">Loading…</p>;
  }

  const { corpus, dataset, chat } = ov;
  const reviewTotal = corpus.review.pending + corpus.review.accepted + corpus.review.rejected;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      {/* header + quick actions */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">Overview</h1>
          <p lang="lo" className="text-muted-foreground text-sm">ໂຮງງານ dataset — ສະຖານະ ແລະ ວຽກຄ້າງ</p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={load} className="text-muted-foreground gap-1">
            <RefreshCw className="size-3.5" /> refresh
          </Button>
          <Link href="/studio/ingest" className="border-input hover:bg-accent inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors">
            <FileUp className="size-4" /> Ingest
          </Link>
          <Link href="/studio/teach" className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors">
            <GraduationCap className="size-4" /> Teach
          </Link>
        </div>
      </div>

      {/* stat cards */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Documents" value={String(corpus.documents)} sub={`avg ${corpus.avgTokens} tok/chunk`} href="/studio/ingest" />
        <Stat label="Chunks" value={String(corpus.chunks)} sub={`${corpus.embedded} embedded (${pct(corpus.embedded, corpus.chunks)}%)`} href="/studio/review" />
        <Stat label="Review accepted" value={`${pct(corpus.review.accepted, reviewTotal)}%`} sub={`${corpus.review.accepted}/${reviewTotal} · ${corpus.review.pending} pending`} href="/studio/review" />
        <Stat label="Verified QA" value={`${dataset.qa.verified}/${dataset.qa.total}`} sub="export-eligible pairs" href="/studio/qa" />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="Glossary terms" value={`${dataset.terms.verified}/${dataset.terms.total}`} sub="verified" href="/studio/glossary" />
        <Stat label="Accounts (CoA)" value={`${dataset.accounts.verified}/${dataset.accounts.total}`} sub="verified" href="/studio/knowledge" />
        <Stat label="Conversations" value={String(chat.conversations)} sub={`${chat.messages} messages`} href="/chat" />
      </div>

      {/* review funnel */}
      <div className="border-border bg-card mt-4 rounded-xl border p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Review funnel</span>
          <Link href="/studio/review" className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs">
            review <ArrowRight className="size-3" />
          </Link>
        </div>
        <div className="mt-2 flex h-3 overflow-hidden rounded-full">
          <div className="bg-emerald-500/80" style={{ width: `${pct(corpus.review.accepted, reviewTotal)}%` }} title={`accepted ${corpus.review.accepted}`} />
          <div className="bg-amber-400/70" style={{ width: `${pct(corpus.review.pending, reviewTotal)}%` }} title={`pending ${corpus.review.pending}`} />
          <div className="bg-destructive/70" style={{ width: `${pct(corpus.review.rejected, reviewTotal)}%` }} title={`rejected ${corpus.review.rejected}`} />
        </div>
        <div className="text-muted-foreground mt-1.5 flex gap-4 text-xs">
          <span>● accepted {corpus.review.accepted}</span>
          <span>● pending {corpus.review.pending}</span>
          <span>● rejected {corpus.review.rejected}</span>
        </div>
        {/* per-collection */}
        <div className="mt-3 space-y-1.5">
          {corpus.byCollection.map((c) => (
            <div key={c.collection} className="flex items-center gap-3 text-xs">
              <Badge variant="secondary" className="w-36 justify-start truncate">{c.collection}</Badge>
              <div className="bg-secondary h-1.5 flex-1 overflow-hidden rounded-full">
                <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${pct(c.accepted, c.chunks)}%` }} />
              </div>
              <span className="text-muted-foreground w-24 text-right tabular-nums">{c.accepted}/{c.chunks} accepted</span>
            </div>
          ))}
        </div>
      </div>

      {/* gaps + activity */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="border-border bg-card rounded-xl border p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageCircleQuestion className="size-4 text-amber-600" />
            <span lang="lo">ຄຳຖາມທີ່ຕອບບໍ່ໄດ້ · gaps</span>
            {gaps && gaps.abstained.length > 0 && <Badge variant="secondary">{gaps.abstained.length}</Badge>}
          </div>
          {!gaps || gaps.abstained.length === 0 ? (
            <p lang="lo" className="text-muted-foreground mt-3 text-sm">ບໍ່ມີ — AI ຕອບໄດ້ທຸກຄຳຖາມທີ່ຜ່ານມາ</p>
          ) : (
            <div className="mt-2 space-y-2">
              {gaps.abstained.map((g, i) => (
                <div key={i} className="border-border rounded-lg border px-3 py-2">
                  <p lang="lo" className="text-sm font-medium">{g.question}</p>
                  <p lang="lo" className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">{g.answer}</p>
                  <Link href="/studio/teach" className="text-primary mt-1 inline-flex items-center gap-1 text-xs font-medium hover:underline">
                    <GraduationCap className="size-3.5" /> ສອນຄຳຕອບ · teach it
                  </Link>
                </div>
              ))}
            </div>
          )}
          {gaps && gaps.reported.length > 0 && (
            <div className="border-border mt-3 border-t pt-2">
              <p className="text-muted-foreground text-xs font-medium">reported chunks ({gaps.reported.length})</p>
              {gaps.reported.map((r) => (
                <p key={r.id} lang="lo" className="text-muted-foreground mt-1 truncate text-xs">
                  <span className="text-foreground">{r.title}</span> — {r.excerpt}
                </p>
              ))}
              <Link href="/studio/review" className="text-primary mt-1 inline-flex items-center gap-1 text-xs hover:underline">
                re-review <ArrowRight className="size-3" />
              </Link>
            </div>
          )}
        </div>

        <div className="border-border bg-card rounded-xl border p-4">
          <p className="text-sm font-medium">Recent activity</p>
          {ov.activity.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm">No events yet</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {ov.activity.map((a, i) => (
                <div key={i} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground w-24 shrink-0 tabular-nums">
                    {new Date(a.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <Badge variant="secondary" className={cn("shrink-0", a.eventType.includes("deleted") && "text-destructive")}>{a.eventType}</Badge>
                  <span className="text-muted-foreground min-w-0 truncate">{a.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
