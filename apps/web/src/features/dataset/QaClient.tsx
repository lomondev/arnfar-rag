"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@arnfar/ui/components/badge";
import { Button } from "@arnfar/ui/components/button";

import { assignSplits, fetchQa, verifyQa, type QaPair } from "./api";

const SPLIT_VARIANT: Record<string, "default" | "secondary" | "muted" | "outline"> = {
  train: "default",
  dev: "secondary",
  test: "outline",
  unassigned: "muted",
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
    <main className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold">QA pairs</h2>
        <span className="text-muted-foreground text-sm">
          {verified}/{qa.length} verified
        </span>
        <Button
          className="ml-auto"
          variant="outline"
          onClick={async () => {
            const r = await assignSplits();
            setStatus(`splits: train ${r.train} · dev ${r.dev} · test ${r.test}`);
            load();
          }}
        >
          Assign splits (by document)
        </Button>
        <span className="text-muted-foreground text-sm">{status}</span>
      </div>

      <ul className="divide-border divide-y rounded-lg border">
        {qa.map((q) => (
          <li key={q.id} className="p-3">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <Badge variant="muted">{q.source}</Badge>
              <Badge variant={SPLIT_VARIANT[q.split] ?? "muted"}>{q.split}</Badge>
              <span className="text-muted-foreground">cites {q.citationIds.length}</span>
              {q.verified ? (
                <Badge variant="secondary" className="ml-auto">
                  ● verified
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={async () => {
                    await verifyQa(q.id);
                    setStatus("verified qa");
                    load();
                  }}
                >
                  Verify
                </Button>
              )}
            </div>
            <div lang="lo" className="font-medium">
              Q: {q.questionLo}
            </div>
            <div lang="lo" className="text-muted-foreground">
              A: {q.answerLo}
            </div>
            {q.citationIds.length === 0 && (
              <div className="text-destructive text-xs">⚠ no citations — cannot export</div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
