"use client";

import { useState } from "react";

import { Button } from "@arnfar/ui/components/button";
import { Textarea } from "@arnfar/ui/components/textarea";

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
    <main className="max-w-3xl px-6 py-5">
      <h2 className="text-lg font-semibold">Lao check</h2>
      <p className="text-muted-foreground text-sm">
        Normalize · spell-check · terminology · rewrite suggestion.
      </p>

      <Textarea
        lang="lo"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="ວາງຂໍ້ຄວາມ ພາສາລາວ ທີ່ນີ້…"
        className="mt-3 min-h-32 text-base"
      />
      <div className="my-3">
        <Button onClick={check} disabled={busy}>
          {busy ? "checking…" : "Check"}
        </Button>
      </div>

      {result && (
        <div className="grid gap-4">
          {/* Honesty banner — mandated. The rewrite is a suggestion, not grammar correction. */}
          <div
            lang="lo"
            className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          >
            ⚠ {result.disclaimer}
          </div>

          <section>
            <h4 className="mb-1 font-medium">
              Normalized{" "}
              <span className="text-muted-foreground font-normal">
                ({result.zeroWidthRemoved} zero-width removed)
              </span>
            </h4>
            <pre lang="lo" className="font-sans text-base whitespace-pre-wrap">
              {result.normalized}
            </pre>
          </section>

          <section>
            <h4 className="mb-1 font-medium">Spelling ({result.spelling.length})</h4>
            {result.spelling.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                no unknown words (dictionary-based; misses valid-subword misspellings)
              </p>
            ) : (
              <ul lang="lo" className="list-disc pl-5">
                {result.spelling.map((s, i) => (
                  <li key={i}>
                    {s.token}{" "}
                    {s.suggestions.length > 0 && (
                      <span className="text-muted-foreground">→ {s.suggestions.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className={`mb-1 font-medium ${result.terminology.length ? "text-destructive" : ""}`}>
              Terminology violations ({result.terminology.length})
            </h4>
            {result.terminology.length === 0 ? (
              <p className="text-muted-foreground text-sm">none</p>
            ) : (
              <ul lang="lo" className="list-disc pl-5">
                {result.terminology.map((v, i) => (
                  <li key={i}>
                    <span className="text-destructive">{v.found}</span> →{" "}
                    <strong>{v.useInstead}</strong>{" "}
                    <span className="text-muted-foreground">({v.termEn})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4 className="mb-1 font-medium">
              Rewrite{" "}
              <span className="text-xs font-normal text-amber-600 dark:text-amber-400">
                — AI suggestion, review before use
              </span>
            </h4>
            <pre lang="lo" className="bg-muted rounded-lg p-3 font-sans text-base whitespace-pre-wrap">
              {result.rewrite}
            </pre>
          </section>
        </div>
      )}
    </main>
  );
}
