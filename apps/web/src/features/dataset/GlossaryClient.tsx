"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchTerms, mineGlossary, patchTerm, verifyTerm, type Term } from "./api";

export function GlossaryClient() {
  const [terms, setTerms] = useState<Term[]>([]);
  const [status, setStatus] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    fetchTerms().then(setTerms).catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const verifiedCount = terms.filter((t) => t.verified).length;

  return (
    <main style={{ padding: "1rem 1.5rem" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Glossary</h2>
        <span style={{ color: "#6b7280" }}>
          {verifiedCount}/{terms.length} verified
        </span>
        <button
          onClick={async () => {
            setStatus("mining…");
            const r = (await mineGlossary({ minFreq: 2, gloss: false })) as { created: unknown[] };
            setStatus(`mined ${r.created.length} candidates`);
            load();
          }}
          style={{ marginLeft: "auto" }}
        >
          Mine candidates
        </button>
        <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>{status}</span>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
            <th style={{ padding: "0.4rem" }}>term_lo</th>
            <th style={{ padding: "0.4rem" }}>segmented</th>
            <th style={{ padding: "0.4rem" }}>term_en (gloss)</th>
            <th style={{ padding: "0.4rem" }}>status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {terms.map((t) => (
            <tr key={t.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <td lang="lo" style={{ padding: "0.4rem", fontSize: "1.05rem" }}>{t.termLo}</td>
              <td lang="lo" style={{ padding: "0.4rem", color: "#64748b" }}>{t.termLoSeg}</td>
              <td style={{ padding: "0.4rem" }}>
                <input
                  defaultValue={t.termEn === "(needs gloss)" ? "" : t.termEn}
                  placeholder="english…"
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  style={{ padding: "0.2rem", width: 160 }}
                />
              </td>
              <td style={{ padding: "0.4rem", color: t.verified ? "#16a34a" : "#9ca3af" }}>
                {t.verified ? "● verified" : "○ draft"}
              </td>
              <td style={{ padding: "0.4rem", whiteSpace: "nowrap" }}>
                <button
                  onClick={async () => {
                    const en = drafts[t.id] ?? t.termEn;
                    if (en && en !== t.termEn) await patchTerm(t.id, { termEn: en });
                    await verifyTerm(t.id);
                    setStatus(`verified ${t.termLo}`);
                    load();
                  }}
                  disabled={t.verified}
                >
                  Verify
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
