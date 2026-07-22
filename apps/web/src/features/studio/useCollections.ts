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
