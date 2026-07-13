"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@arnfar/ui/components/button";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

interface EvalRun {
  id: string;
  retriever: string;
  genModel: string;
  recallAt5: string | null;
  recallAt10: string | null;
  mrr: string | null;
  faithfulness: string | null;
  p95LatencyMs: number | null;
  nQueries: number;
  notes: string | null;
  createdAt: string;
}

const GATE = { recallAt5: 0.7, faithfulness: 0.8, p95LatencyMs: 150 };

function Metric({
  value,
  threshold,
  higherIsBetter = true,
}: {
  value: string | null;
  threshold: number;
  higherIsBetter?: boolean;
}) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(() => {
    fetch(`${BASE}/eval/runs`)
      .then((r) => r.json())
      .then(setRuns)
      .catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const runMatrix = async (generate: boolean) => {
    setBusy(true);
    setStatus(generate ? "running matrix + generation (slow)…" : "running retrieval matrix…");
    try {
      await fetch(`${BASE}/eval/matrix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generate,
          adversarial: generate ? ["ອັດຕາພາສີ VAT ຢູ່ລາວ ແມ່ນ ເທົ່າໃດ?"] : [],
        }),
      });
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
        GATE 6 (hybrid): recall@5 ≥ 0.70 · faithfulness ≥ 0.80 · p95 &lt; 150ms · abstention ≥ 0.90.
        Green/red = threshold.
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              {["retriever", "gen_model", "n", "recall@5", "recall@10", "MRR", "faithful", "p95 ms", "notes"].map(
                (h) => (
                  <th key={h} className="p-2 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="p-2 font-medium">{r.retriever}</td>
                <td className="text-muted-foreground p-2">{r.genModel}</td>
                <td className="p-2">{r.nQueries}</td>
                <td className="p-2">
                  <Metric value={r.recallAt5} threshold={GATE.recallAt5} />
                </td>
                <td className="p-2">{r.recallAt10 ? Number(r.recallAt10).toFixed(3) : "—"}</td>
                <td className="p-2">{r.mrr ? Number(r.mrr).toFixed(3) : "—"}</td>
                <td className="p-2">
                  <Metric value={r.faithfulness} threshold={GATE.faithfulness} />
                </td>
                <td className="p-2">
                  {r.p95LatencyMs === null ? (
                    "—"
                  ) : (
                    <Metric
                      value={String(r.p95LatencyMs)}
                      threshold={GATE.p95LatencyMs}
                      higherIsBetter={false}
                    />
                  )}
                </td>
                <td className="text-muted-foreground p-2">{r.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
