"use client";

import { useEffect, useState } from "react";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

export interface ModelList {
  /** The server's configured default generator — selected until the user picks another. */
  readonly default: string;
  /** Every installed generator model (embedding models excluded). */
  readonly models: readonly string[];
}

const EMPTY: ModelList = { default: "", models: [] };

/**
 * Live list of installed Ollama generator models, fetched through rag-api (the browser
 * never talks to Ollama directly — CLAUDE.md). Empty until it loads; the picker hides
 * itself when there is nothing to choose between.
 */
export function useModels(): ModelList {
  const [list, setList] = useState<ModelList>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${BASE}/chat/models`)
      .then((r) => (r.ok ? (r.json() as Promise<ModelList>) : null))
      .then((data) => {
        if (!cancelled && data && data.models.length) setList(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

/** A compact, human-friendly label for a model tag — the raw `hf.co/...:latest` id is unusable in a dropdown. */
export function shortModel(name: string): string {
  if (/sea-lion/i.test(name)) return "SEA-LION";
  const segment = name.includes("/") ? (name.split("/").pop() ?? name) : name;
  return segment.replace(/:latest$/, "");
}
