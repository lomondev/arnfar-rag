"use client";

import { useCallback, useEffect, useState } from "react";

import { assignSplits, fetchQa, verifyQa, type QaPair } from "./api";

const SPLIT_COLOR: Record<string, string> = {
  train: "#2563eb",
  dev: "#7c3aed",
  test: "#b45309",
  unassigned: "#9ca3af",
};

export function QaClient() {
  const [qa, setQa] = useState<QaPair[]>([]);
  const [status, setStatus] = useState("");

  const load = useCallback(() => {
    fetchQa().then(setQa).catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const verified = qa.filter((q) => q.verified).length;

  return (
    <main style={{ padding: "1rem 1.5rem" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>QA pairs</h2>
        <span style={{ color: "#6b7280" }}>{verified}/{qa.length} verified</span>
        <button
          onClick={async () => {
            const r = await assignSplits();
            setStatus(`splits: train ${r.train} · dev ${r.dev} · test ${r.test}`);
            load();
          }}
          style={{ marginLeft: "auto" }}
        >
          Assign splits (by document)
        </button>
        <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>{status}</span>
      </div>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {qa.map((q) => (
          <li key={q.id} style={{ borderBottom: "1px solid #f1f5f9", padding: "0.6rem 0" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.75rem", marginBottom: 4 }}>
              <span style={{ background: "#334155", color: "white", borderRadius: 4, padding: "0 0.35rem" }}>{q.source}</span>
              <span style={{ color: SPLIT_COLOR[q.split] }}>{q.split}</span>
              <span style={{ color: "#94a3b8" }}>cites {q.citationIds.length}</span>
              <span style={{ color: q.verified ? "#16a34a" : "#9ca3af", marginLeft: "auto" }}>
                {q.verified ? "● verified" : "○ draft"}
              </span>
              {!q.verified && (
                <button
                  onClick={async () => {
                    await verifyQa(q.id);
                    setStatus(`verified qa`);
                    load();
                  }}
                >
                  Verify
                </button>
              )}
            </div>
            <div lang="lo" style={{ fontWeight: 600 }}>Q: {q.questionLo}</div>
            <div lang="lo" style={{ color: "#475569" }}>A: {q.answerLo}</div>
            {q.citationIds.length === 0 && (
              <div style={{ color: "#dc2626", fontSize: "0.8rem" }}>⚠ no citations — cannot export</div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
