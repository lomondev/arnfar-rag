"use client";

import { useState } from "react";

import { runExport, type ExportResult } from "./api";

export function ExportClient() {
  const [version, setVersion] = useState("0.2.0");
  const [shareable, setShareable] = useState(true);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main style={{ padding: "1rem 1.5rem", maxWidth: 820 }}>
      <h2>Export dataset</h2>
      <p style={{ color: "#6b7280" }}>
        Writes an immutable, versioned dataset to <code>datasets/lao-accounting/vX.Y.Z/</code>.
        Only verified rows; rejected chunks and (when shareable) client-confidential rows are
        excluded; QA is split by document.
      </p>

      <div style={{ display: "flex", gap: "1rem", alignItems: "center", margin: "1rem 0" }}>
        <label>
          version&nbsp;
          <input value={version} onChange={(e) => setVersion(e.target.value)} style={{ padding: "0.3rem", width: 90 }} />
        </label>
        <label>
          <input type="checkbox" checked={shareable} onChange={(e) => setShareable(e.target.checked)} /> shareable
        </label>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setResult(await runExport(version, shareable));
            setBusy(false);
          }}
        >
          {busy ? "exporting…" : "Export"}
        </button>
      </div>

      {result?.error && <p style={{ color: "#dc2626" }}>Error: {result.error}</p>}
      {result && !result.error && (
        <div>
          <p style={{ color: "#16a34a" }}>✓ wrote {result.dir}</p>
          <table style={{ borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
                <th style={{ padding: "0.3rem 0.6rem" }}>file</th>
                <th style={{ padding: "0.3rem 0.6rem" }}>records</th>
                <th style={{ padding: "0.3rem 0.6rem" }}>sha256</th>
              </tr>
            </thead>
            <tbody>
              {result.files.map((f) => (
                <tr key={f.name} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{f.name}</td>
                  <td style={{ padding: "0.3rem 0.6rem" }}>{f.records}</td>
                  <td style={{ padding: "0.3rem 0.6rem", fontFamily: "monospace", color: "#64748b" }}>
                    {f.sha256.slice(0, 16)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.warnings.length > 0 && (
            <ul style={{ color: "#b45309" }}>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
        </div>
      )}
    </main>
  );
}
