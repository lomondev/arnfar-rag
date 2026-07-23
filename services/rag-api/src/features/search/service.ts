import { schema } from "@arnfar/db";
import type { TenantContext } from "@arnfar/db";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { embedOne } from "../../lib/ollama.ts";
import { segment } from "../../lib/sidecars.ts";
import { expandWithGlossary, type GlossaryMatch } from "./glossary.ts";
import { hybridSearch, type SearchHit } from "./query.ts";

/** Canonical starter collections — suggestions only, NOT a filter allowlist.
 *  Collections are user-creatable (knowledge kinds, ingest); listCollections()
 *  enumerates what actually exists. */
export const CANONICAL_COLLECTIONS = [
  "lao-accounting-law",
  "coa",
  "tax",
  "sop",
  "lao-style",
] as const;

export interface SearchParams {
  query: string;
  collections?: string[];
  /** Scope retrieval to these knowledge kinds (chunk meta.knowledge_kind). */
  kinds?: string[];
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

/** Every collection that exists for this tenant (chunks + knowledge kinds), plus the
 *  canonical starters — the suggestion list for pickers and the kind dialog. */
export async function listCollections(tenant: TenantContext): Promise<string[]> {
  const fromChunks = await db()
    .select({ c: schema.ragChunk.collection })
    .from(schema.ragChunk)
    .where(
      and(eq(schema.ragChunk.hfId, tenant.hfId), eq(schema.ragChunk.companyId, tenant.companyId)),
    )
    .groupBy(schema.ragChunk.collection);
  const fromKinds = await db()
    .select({ c: sql<string>`distinct collection` })
    .from(schema.knowledgeKind)
    .where(
      and(
        eq(schema.knowledgeKind.hfId, tenant.hfId),
        eq(schema.knowledgeKind.companyId, tenant.companyId),
      ),
    );
  return [
    ...new Set([
      ...CANONICAL_COLLECTIONS,
      ...fromChunks.map((r) => r.c),
      ...fromKinds.map((r) => r.c),
    ]),
  ].sort();
}

export async function search(p: SearchParams): Promise<SearchResponse> {
  // No collections requested = search the whole tenant corpus (collections are
  // user-creatable, so a fixed fallback list would hide entries in new ones).
  const collections = p.collections ?? [];
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
    kinds: p.kinds ?? [],
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
