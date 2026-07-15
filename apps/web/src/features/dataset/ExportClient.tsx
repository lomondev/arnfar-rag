"use client";

import { useState } from "react";

import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";

import { runExport, type ExportResult } from "./api";

export function ExportClient() {
  const [version, setVersion] = useState("0.2.0");
  const [shareable, setShareable] = useState(true);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="max-w-3xl px-6 py-5">
      <h2 className="text-lg font-semibold">Export dataset</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Writes an immutable, versioned dataset to{" "}
        <code className="bg-muted rounded px-1">datasets/lao-accounting/vX.Y.Z/</code>. Verified rows
        only; rejected chunks and (when shareable) client-confidential rows are excluded; QA is split
        by document.
      </p>

      <div className="my-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          version
          <Input value={version} onChange={(e) => setVersion(e.target.value)} className="w-24" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={shareable}
            onChange={(e) => setShareable(e.target.checked)}
          />
          shareable
        </label>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setResult(await runExport(version, shareable));
            setBusy(false);
          }}
        >
          {busy ? "exporting…" : "Export"}
        </Button>
      </div>

      {result?.error && <p className="text-destructive">Error: {result.error}</p>}
      {result && !result.error && (
        <div>
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            ✓ wrote {result.dir}
          </p>
          <div className="mt-2 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-b text-left">
                <tr>
                  <th className="p-2 font-medium">file</th>
                  <th className="p-2 font-medium">records</th>
                  <th className="p-2 font-medium">sha256</th>
                </tr>
              </thead>
              <tbody>
                {result.files.map((f) => (
                  <tr key={f.name} className="border-b last:border-0">
                    <td className="p-2">{f.name}</td>
                    <td className="p-2">{f.records}</td>
                    <td className="text-muted-foreground p-2 font-mono">{f.sha256.slice(0, 16)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.warnings.length > 0 && (
            <ul className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}
