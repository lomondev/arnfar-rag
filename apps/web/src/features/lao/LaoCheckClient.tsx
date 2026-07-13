"use client";

import { useState } from "react";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

interface Result {
  original: string;
  normalized: string;
  zeroWidthRemoved: number;
  lang: string;
  spelling: { token: string; suggestions: string[] }[];
  terminology: { found: string; useInstead: string; termEn: string }[];
  rewrite: string;
  disclaimer: string;
}

export function LaoCheckClient() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/lao/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setResult(await res.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: "1rem 1.5rem", maxWidth: 820 }}>
      <h2>Lao check</h2>
      <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>
        Normalize · spell-check · terminology · rewrite suggestion.
      </p>

      <textarea
        lang="lo"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="ວາງຂໍ້ຄວາມ ພາສາລາວ ທີ່ນີ້…"
        style={{ width: "100%", minHeight: 120, fontSize: "1.05rem", padding: "0.5rem" }}
      />
      <div style={{ margin: "0.5rem 0" }}>
        <button onClick={check} disabled={busy}>{busy ? "checking…" : "Check"}</button>
      </div>

      {result && (
        <div>
          {/* Honesty banner — mandated. The rewrite is a suggestion, not grammar correction. */}
          <div
            style={{
              background: "#fef3c7",
              border: "1px solid #f59e0b",
              borderRadius: 6,
              padding: "0.6rem 0.8rem",
              margin: "0.5rem 0 1rem",
              fontSize: "0.85rem",
            }}
            lang="lo"
          >
            ⚠ {result.disclaimer}
          </div>

          <section style={{ marginBottom: "1rem" }}>
            <h4 style={{ margin: "0 0 0.25rem" }}>Normalized ({result.zeroWidthRemoved} zero-width removed)</h4>
            <pre lang="lo" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "1.05rem", margin: 0 }}>
              {result.normalized}
            </pre>
          </section>

          <section style={{ marginBottom: "1rem" }}>
            <h4 style={{ margin: "0 0 0.25rem" }}>Spelling ({result.spelling.length})</h4>
            {result.spelling.length === 0 ? (
              <p style={{ color: "#9ca3af", margin: 0 }}>no unknown words (dictionary-based; misses valid-subword misspellings)</p>
            ) : (
              <ul lang="lo">
                {result.spelling.map((s, i) => (
                  <li key={i}>{s.token} {s.suggestions.length > 0 && <span style={{ color: "#6b7280" }}>→ {s.suggestions.join(", ")}</span>}</li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ marginBottom: "1rem" }}>
            <h4 style={{ margin: "0 0 0.25rem", color: result.terminology.length ? "#dc2626" : undefined }}>
              Terminology violations ({result.terminology.length})
            </h4>
            {result.terminology.length === 0 ? (
              <p style={{ color: "#9ca3af", margin: 0 }}>none</p>
            ) : (
              <ul lang="lo">
                {result.terminology.map((v, i) => (
                  <li key={i}>
                    <span style={{ color: "#dc2626" }}>{v.found}</span> → <strong>{v.useInstead}</strong>{" "}
                    <span style={{ color: "#6b7280" }}>({v.termEn})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 style={{ margin: "0 0 0.25rem" }}>
              Rewrite <span style={{ color: "#b45309", fontWeight: 400, fontSize: "0.8rem" }}>— AI suggestion, review before use</span>
            </h4>
            <pre lang="lo" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "1.05rem", margin: 0, background: "#f8fafc", padding: "0.6rem", borderRadius: 6 }}>
              {result.rewrite}
            </pre>
          </section>
        </div>
      )}
    </main>
  );
}
