"use client";

import { Button } from "@arnfar/ui/components/button";
import { useCallback, useEffect, useState } from "react";
import { apiBaseUrl } from "@/lib/api";

const BASE = apiBaseUrl();

/** Mirrors GATE_MIN_QUERIES in rag-api's eval/metrics.ts. */
const MIN_QUERIES_FOR_GATE = 30;

interface EvalRun {
  id: string;
  retriever: string;
  genModel: string;
  recallAt5: string | null;
  recallAt10: string | null;
  precisionAt5: string | null;
  ndcgAt10: string | null;
  hitRateAt5: string | null;
  mrr: string | null;
  faithfulness: string | null;
  p95LatencyMs: number | null;
  nQueries: number;
  notes: string | null;
  createdAt: string;
}

/**
 * GATE 6, as written in CLAUDE.md and docs/ROADMAP.md: recall@5 ≥ 0.9, faithfulness ≥ 0.8,
 * p95 retrieval < 150ms. This table painted 0.70 green, so a run that misses the gate by a
 * fifth of the metric read as a pass.
 */
const GATE = { recallAt5: 0.9, faithfulness: 0.8, p95LatencyMs: 150 };

/** Which arms this deployment can measure. `hybrid-rrf+rerank` needs the cross-encoder
 *  build of lao-nlp, so the matrix is three arms or four depending on the image. */
interface Capabilities {
  retrievers: string[];
  rerank: boolean;
  rerankHint: string | null;
}

function Metric({
  value,
  threshold,
  higherIsBetter = true,
  measured = true,
}: {
  value: string | null;
  threshold: number;
  higherIsBetter?: boolean;
  /** False for a run with no gold queries: the stored 0.0000 is an artefact, not a score. */
  measured?: boolean;
}) {
  if (!measured || value === null) return <span className="text-muted-foreground">—</span>;
  const n = Number(value);
  const pass = higherIsBetter ? n >= threshold : n <= threshold;
  return (
    <span className={pass ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
      {n.toFixed(3)}
    </span>
  );
}

export function EvalClient() {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(() => {
    fetch(`${BASE}/eval/runs`)
      .then((r) => r.json())
      .then(setRuns)
      .catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    fetch(`${BASE}/eval/capabilities`)
      .then((r) => r.json())
      .then(setCaps)
      // Silent: a missing capability list only costs the hint line below. Retrieval
      // itself is unaffected, and an error banner here would read as an eval failure.
      .catch(() => setCaps(null));
  }, []);

  const runMatrix = async (generate: boolean) => {
    setBusy(true);
    setStatus(generate ? "running matrix + generation (slow)…" : "running retrieval matrix…");
    try {
      const res = await fetch(`${BASE}/eval/matrix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generate,
          adversarial: generate ? ["ອັດຕາພາສີ VAT ຢູ່ລາວ ແມ່ນ ເທົ່າໃດ?"] : [],
        }),
      });
      // fetch only rejects on a network failure, so without this a 422 "no verified QA
      // pairs" landed in the UI as "done" and the operator went looking for the new row.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
          remedy?: string;
        } | null;
        setStatus(
          body?.message
            ? `${body.message}${body.remedy ? ` — ${body.remedy}` : ""}`
            : `eval failed: HTTP ${res.status}`,
        );
        return;
      }
      setStatus("done");
      load();
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="px-6 py-5">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-lg font-semibold">Eval</h2>
        <Button variant="outline" disabled={busy} onClick={() => runMatrix(false)}>
          Run retrieval matrix
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => runMatrix(true)}>
          Run matrix + faithfulness
        </Button>
        <span className="text-muted-foreground text-sm">{status}</span>
      </div>
      <p className="text-muted-foreground mb-3 text-sm">
        GATE 6 (hybrid): recall@5 ≥ 0.90 · faithfulness ≥ 0.80 · p95 &lt; 150ms · abstention ≥ 0.90.
        Green/red = threshold. A run needs at least {MIN_QUERIES_FOR_GATE} verified QA pairs before
        its numbers can settle the gate either way.
      </p>
      {caps ? (
        <p className="text-muted-foreground mb-3 text-sm">
          Matrix arms: {caps.retrievers.join(" · ")}.{" "}
          {caps.rerank
            ? "Cross-encoder reranking is measurable — it is an eval arm only, not on the /chat path."
            : caps.rerankHint}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              {[
                "retriever",
                "gen_model",
                "n",
                "recall@5",
                "recall@10",
                "hit@5",
                "nDCG@10",
                "prec@5",
                "MRR",
                "faithful",
                "p95 ms",
                "notes",
              ].map((h) => (
                <th key={h} className="p-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-2 font-medium">{r.retriever}</td>
                <td className="text-muted-foreground p-2">{r.genModel}</td>
                <td className="p-2">
                  {/* Rows written before the runner refused empty samples still carry
                   * n=0 with 0.0000 metrics. Say what they are instead of ranking them. */}
                  {r.nQueries === 0 ? (
                    <span className="text-destructive font-medium" title="not a measurement">
                      0
                    </span>
                  ) : r.nQueries < MIN_QUERIES_FOR_GATE ? (
                    <span
                      className="text-amber-600 dark:text-amber-400"
                      title={`below the ${MIN_QUERIES_FOR_GATE}-query threshold for gate evidence`}
                    >
                      {r.nQueries}
                    </span>
                  ) : (
                    r.nQueries
                  )}
                </td>
                <td className="p-2">
                  <Metric
                    value={r.recallAt5}
                    threshold={GATE.recallAt5}
                    measured={r.nQueries > 0}
                  />
                </td>
                <td className="p-2">
                  {r.nQueries > 0 && r.recallAt10 ? Number(r.recallAt10).toFixed(3) : "—"}
                </td>
                {/* Diagnostic columns, deliberately uncoloured — only recall@5,
                 * faithfulness and p95 are gate thresholds, and painting a number green
                 * that no gate reads is how 0.70 came to look like a pass. Runs from
                 * before migration 0005 have no value here and render "—". */}
                <td className="p-2">
                  {r.nQueries > 0 && r.hitRateAt5 ? Number(r.hitRateAt5).toFixed(3) : "—"}
                </td>
                <td className="p-2">
                  {r.nQueries > 0 && r.ndcgAt10 ? Number(r.ndcgAt10).toFixed(3) : "—"}
                </td>
                <td className="p-2" title="capped by gold-set size — a tripwire, not a gate">
                  {r.nQueries > 0 && r.precisionAt5 ? Number(r.precisionAt5).toFixed(3) : "—"}
                </td>
                <td className="p-2">{r.nQueries > 0 && r.mrr ? Number(r.mrr).toFixed(3) : "—"}</td>
                <td className="p-2">
                  <Metric
                    value={r.faithfulness}
                    threshold={GATE.faithfulness}
                    measured={r.nQueries > 0}
                  />
                </td>
                <td className="p-2">
                  {r.p95LatencyMs === null ? (
                    "—"
                  ) : (
                    <Metric
                      value={String(r.p95LatencyMs)}
                      threshold={GATE.p95LatencyMs}
                      higherIsBetter={false}
                      measured={r.nQueries > 0}
                    />
                  )}
                </td>
                <td className="text-muted-foreground p-2">
                  {r.nQueries === 0 ? "not a measurement — 0 verified QA pairs" : (r.notes ?? "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
