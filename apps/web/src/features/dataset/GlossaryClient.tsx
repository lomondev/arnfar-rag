"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@arnfar/ui/components/badge";
import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";

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
    <main className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold">Glossary</h2>
        <span className="text-muted-foreground text-sm">
          {verifiedCount}/{terms.length} verified
        </span>
        <Button
          className="ml-auto"
          variant="outline"
          onClick={async () => {
            setStatus("mining…");
            const r = (await mineGlossary({ minFreq: 2, gloss: false })) as { created: unknown[] };
            setStatus(`mined ${r.created.length} candidates`);
            load();
          }}
        >
          Mine candidates
        </Button>
        <span className="text-muted-foreground text-sm">{status}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th className="p-2 font-medium">term_lo</th>
              <th className="p-2 font-medium">segmented</th>
              <th className="p-2 font-medium">term_en (gloss)</th>
              <th className="p-2 font-medium">status</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {terms.map((t) => (
              <tr key={t.id} className="hover:bg-muted/40 border-b last:border-0">
                <td lang="lo" className="p-2 text-base">
                  {t.termLo}
                </td>
                <td lang="lo" className="text-muted-foreground p-2">
                  {t.termLoSeg}
                </td>
                <td className="p-2">
                  <Input
                    defaultValue={t.termEn === "(needs gloss)" ? "" : t.termEn}
                    placeholder="english…"
                    className="w-40"
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                  />
                </td>
                <td className="p-2">
                  {t.verified ? (
                    <Badge variant="secondary">● verified</Badge>
                  ) : (
                    <Badge variant="muted">○ draft</Badge>
                  )}
                </td>
                <td className="p-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={t.verified}
                    onClick={async () => {
                      const en = drafts[t.id] ?? t.termEn;
                      if (en && en !== t.termEn) await patchTerm(t.id, { termEn: en });
                      await verifyTerm(t.id);
                      setStatus(`verified ${t.termLo}`);
                      load();
                    }}
                  >
                    Verify
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
