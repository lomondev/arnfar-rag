import type { TenantContext } from "@arnfar/db";

import { embedOne } from "../../lib/ollama.ts";
import { segment } from "../../lib/sidecars.ts";
import { expandWithGlossary, type GlossaryMatch } from "./glossary.ts";
import { hybridSearch, type SearchHit } from "./query.ts";

export const ALL_COLLECTIONS = [
  "lao-accounting-law",
  "coa",
  "tax",
  "sop",
  "lao-style",
] as const;

export interface SearchParams {
  query: string;
  collections?: string[];
  k?: number;
  tenant: TenantContext;
  explain?: boolean;
}

export interface SearchResponse {
  query: string;
  querySeg: string;
  glossaryMatches: GlossaryMatch[];
  hits: SearchHit[];
  explain?: string;
}

export async function search(p: SearchParams): Promise<SearchResponse> {
  const collections = p.collections?.length ? p.collections : [...ALL_COLLECTIONS];
  const k = p.k ?? 8;

  // Segment (for lexical) and embed (natural form, for dense) in parallel.
  const [seg, queryEmbedding] = await Promise.all([
    segment(p.query),
    embedOne(p.query),
  ]);

  const { extraSeg, matched } = await expandWithGlossary(p.query, p.tenant);
  const querySeg = extraSeg ? `${seg.seg_text} ${extraSeg}` : seg.seg_text;

  const result = await hybridSearch({
    tenant: p.tenant,
    collections,
    queryEmbedding,
    querySeg,
    k,
    explain: p.explain,
  });

  return {
    query: p.query,
    querySeg,
    glossaryMatches: matched,
    hits: result.hits,
    ...(result.explain ? { explain: result.explain } : {}),
  };
}
