"use client";

import { useEffect, useState } from "react";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

/** Canonical starters — instant fallback until (or if) the live list loads. */
export const CANONICAL_COLLECTIONS = [
  "coa",
  "lao-accounting-law",
  "lao-style",
  "sop",
  "tax",
] as const;

export interface KnowledgeKindOption {
  key: string;
  nameLo: string;
  nameEn: string | null;
  entries: number;
}

/** Live knowledge kinds — the /chat and /studio scope pickers list these by name
 *  so users think in their own categories, not collection slugs. */
export function useKnowledgeKinds(): readonly KnowledgeKindOption[] {
  const [kinds, setKinds] = useState<readonly KnowledgeKindOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${BASE}/knowledge/kinds`)
      .then((r) => (r.ok ? (r.json() as Promise<KnowledgeKindOption[]>) : null))
      .then((list) => {
        if (!cancelled && list) setKinds(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return kinds;
}

/** Live collection list (canonical + everything users created via knowledge kinds
 *  or ingest). Collections are user-creatable, so pickers must not hardcode. */
export function useCollections(): readonly string[] {
  const [collections, setCollections] = useState<readonly string[]>(CANONICAL_COLLECTIONS);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${BASE}/search/collections`)
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : null))
      .then((list) => {
        if (!cancelled && list && list.length) setCollections(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return collections;
}
