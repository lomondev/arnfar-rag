import type { TenantContext } from "@arnfar/db";
import { sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { rerank } from "../../lib/sidecars.ts";
import { applyAnnSessionSettings, candidatePool, hybridSearch } from "../search/query.ts";

export type Retriever = "dense" | "lexical" | "hybrid-rrf" | "hybrid-rrf+rerank";

/** Candidates handed to the cross-encoder before it cuts to `k`.
 *
 *  A reranker can only reorder what it is given, so the arm has to retrieve wider than it
 *  keeps — reranking the same 10 rows RRF already ranked measures almost nothing. 40 is
 *  the usual retrieve-wide/keep-narrow ratio at k=10 and stays inside the RRF candidate
 *  pool (100), so no extra database work is done to produce them. */
export const RERANK_CANDIDATES = 40;

export interface RetrieveParams {
  tenant: TenantContext;
  collections: string[];
  queryEmbedding: number[];
  querySeg: string;
  k: number;
  /** The raw question. Required by `hybrid-rrf+rerank`: a cross-encoder reads the query
   *  and the chunk together, and it must read the question a person asked — not the
   *  space-injected `content_seg` form, which corrupts its tokenization exactly as it
   *  does bge-m3's. Optional so the three non-rerank arms are unaffected. */
  queryText?: string;
}

/** Empty list = no collection filter (collections are user-creatable). */
function collPred(collections: string[]) {
  if (!collections.length) return sql``;
  return sql`AND collection IN (${sql.join(
    collections.map((c) => sql`${c}`),
    sql`, `,
  )})`;
}

/** Return chunk ids in rank order for a retrieval mode. All modes carry the tenant
 *  predicate and exclude rejected chunks (CLAUDE.md).
 *
 *  `hybrid-rrf` runs the production retriever itself; `dense` and `lexical` are
 *  single-arm baselines that exist to show what fusion buys. The baselines share
 *  production's candidate sizing and ANN scan settings, so a comparison isolates the
 *  fusion rather than a scan configuration that happens to differ. */
export async function retrieve(mode: Retriever, p: RetrieveParams): Promise<string[]> {
  // Call the real retriever — a second copy of the RRF SQL drifts from the one that
  // serves users (candidate floor, ef_search, scan caps), and then the run reports
  // numbers for a retriever nobody queries. `kinds` is empty: the harness evaluates the
  // whole corpus, and kind scoping is a UI filter applied on top of these same arms.
  if (mode === "hybrid-rrf+rerank") {
    // Narrowed here rather than asserted at the call site: a cross-encoder scores
    // (query, chunk) as a pair, and the only other query string in scope is `content_seg`,
    // whose injected word-boundary spaces corrupt its tokenization exactly as they corrupt
    // bge-m3's. Checked before the query runs — a misconfigured arm should cost nothing.
    const queryText = p.queryText;
    if (!queryText) {
      throw new Error("hybrid-rrf+rerank requires queryText — the cross-encoder scores the pair");
    }
    const { hits } = await hybridSearch({
      tenant: p.tenant,
      collections: p.collections,
      kinds: [],
      queryEmbedding: p.queryEmbedding,
      querySeg: p.querySeg,
      // Retrieve wide, keep narrow — the reranker can only reorder what it is given.
      k: Math.max(p.k, RERANK_CANDIDATES),
    });
    // `content`, not content_norm/content_seg: the cross-encoder is a reader, and it
    // should read what a person reads. Errors are NOT swallowed — an arm that quietly
    // degrades to plain RRF would report the reranker's numbers for a pipeline that never
    // ran it, which is the exact class of lie this harness exists to prevent.
    const { hits: ranked } = await rerank(
      queryText,
      hits.map((h) => h.content),
      p.k,
    );
    return ranked.map((r) => hits[r.index]!.id);
  }

  if (mode === "hybrid-rrf") {
    const { hits } = await hybridSearch({
      tenant: p.tenant,
      collections: p.collections,
      kinds: [],
      queryEmbedding: p.queryEmbedding,
      querySeg: p.querySeg,
      k: p.k,
    });
    return hits.map((h) => h.id);
  }

  const vec = `[${p.queryEmbedding.join(",")}]`;
  const cols = collPred(p.collections);

  return db().transaction(async (tx) => {
    if (mode === "dense") {
      await applyAnnSessionSettings(tx, candidatePool(p.k));
      const rows = (await tx.execute(sql`
        SELECT id FROM rag_chunk
        WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
          ${cols} AND review <> 'rejected' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::halfvec
        LIMIT ${p.k}
      `)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    // lexical — no ANN involved, so no scan settings to apply.
    const rows = (await tx.execute(sql`
      SELECT id FROM rag_chunk
      WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
        ${cols} AND review <> 'rejected'
        AND fts @@ plainto_tsquery('simple', ${p.querySeg})
      ORDER BY ts_rank_cd(fts, plainto_tsquery('simple', ${p.querySeg})) DESC
      LIMIT ${p.k}
    `)) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  });
}
