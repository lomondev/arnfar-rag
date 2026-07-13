"use client";

import { useCallback, useEffect, useState } from "react";

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

function cell(value: string | null, threshold: number, higherIsBetter = true) {
  if (value === null) return <span style={{ color: "#9ca3af" }}>—</span>;
  const n = Number(value);
  const pass = higherIsBetter ? n >= threshold : n <= threshold;
  return <span style={{ color: pass ? "#16a34a" : "#dc2626" }}>{n.toFixed(3)}</span>;
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
    <main style={{ padding: "1rem 1.5rem" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Eval</h2>
        <button disabled={busy} onClick={() => runMatrix(false)}>Run retrieval matrix</button>
        <button disabled={busy} onClick={() => runMatrix(true)}>Run matrix + faithfulness</button>
        <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>{status}</span>
      </div>
      <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>
        GATE 6 (hybrid): recall@5 ≥ 0.70 · faithfulness ≥ 0.80 · p95 &lt; 150ms · abstention ≥ 0.90.
        Green/red = threshold. Meaningful only on a real corpus.
      </p>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.88rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
            {["retriever", "gen_model", "n", "recall@5", "recall@10", "MRR", "faithful", "p95 ms", "notes"].map((h) => (
              <th key={h} style={{ padding: "0.4rem" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <td style={{ padding: "0.4rem", fontWeight: 600 }}>{r.retriever}</td>
              <td style={{ padding: "0.4rem" }}>{r.genModel}</td>
              <td style={{ padding: "0.4rem" }}>{r.nQueries}</td>
              <td style={{ padding: "0.4rem" }}>{cell(r.recallAt5, GATE.recallAt5)}</td>
              <td style={{ padding: "0.4rem" }}>{r.recallAt10 ? Number(r.recallAt10).toFixed(3) : "—"}</td>
              <td style={{ padding: "0.4rem" }}>{r.mrr ? Number(r.mrr).toFixed(3) : "—"}</td>
              <td style={{ padding: "0.4rem" }}>{cell(r.faithfulness, GATE.faithfulness)}</td>
              <td style={{ padding: "0.4rem" }}>{r.p95LatencyMs === null ? "—" : cell(String(r.p95LatencyMs), GATE.p95LatencyMs, false)}</td>
              <td style={{ padding: "0.4rem", color: "#64748b" }}>{r.notes ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
