import type { TenantContext } from "@arnfar/db";
import { sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";

/** Hybrid retrieval — dense (HNSW over content_norm embeddings) + lexical (FTS over
 *  content_seg) fused with Reciprocal Rank Fusion (k=60, the published default; do
 *  NOT tune before the eval set exists). Implements PROMPT.md §5 verbatim.
 *
 *  Every CTE carries the tenant predicate (hf_id + company_id) and excludes rejected
 *  chunks — no query touches rag_chunk without the tenant filter. */

export interface SearchHit {
  id: string;
  document_id: string;
  content: string;
  heading_path: string[];
  kind: string;
  meta: Record<string, unknown>;
  title: string;
  authority: string | null;
  effective_date: string | null;
  score: number;
}

export interface HybridSearchParams {
  tenant: TenantContext;
  collections: string[];
  queryEmbedding: number[];
  querySeg: string;
  k: number;
  explain?: boolean;
}

export interface HybridSearchResult {
  hits: SearchHit[];
  explain?: string;
}

/** RRF candidate-pool floor. Each arm fuses at least this many candidates so the top
 *  result is stable regardless of the requested page size `k`. Below this, a small `k`
 *  starves the fusion (k=1 → 4 candidates/arm) and a spurious dense neighbour can outrank
 *  the real hit. HNSW already computes ef_search (100) candidates, so raising the pool to
 *  this floor just stops discarding rows it already found — near-zero extra cost. */
const RRF_POOL_MIN = 100;

function rrfQuery(p: HybridSearchParams, cand: number) {
  const vec = `[${p.queryEmbedding.join(",")}]`;
  // Collections are user-creatable now — an empty list means "no collection filter"
  // (tenant + review guards still apply), so entries in novel collections are reachable.
  const collPred = p.collections.length
    ? sql`AND collection IN (${sql.join(p.collections.map((c) => sql`${c}`), sql`, `)})`
    : sql``;
  return sql`
    WITH dense AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vec}::halfvec) AS rank
      FROM rag_chunk
      WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
        ${collPred}
        AND review <> 'rejected' AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::halfvec
      LIMIT ${cand}
    ),
    lexical AS (
      SELECT id, ROW_NUMBER() OVER (
               ORDER BY ts_rank_cd(fts, plainto_tsquery('simple', ${p.querySeg})) DESC) AS rank
      FROM rag_chunk
      WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
        ${collPred}
        AND review <> 'rejected'
        AND fts @@ plainto_tsquery('simple', ${p.querySeg})
      LIMIT ${cand}
    ),
    fused AS (
      SELECT COALESCE(d.id, l.id) AS id,
             COALESCE(1.0 / (60 + d.rank), 0.0) + COALESCE(1.0 / (60 + l.rank), 0.0) AS score
      FROM dense d FULL OUTER JOIN lexical l USING (id)
    )
    SELECT c.id, c.document_id, c.content, c.heading_path, c.kind, c.meta,
           d.title, d.authority, d.effective_date, f.score::float8 AS score
    FROM fused f
    JOIN rag_chunk c ON c.id = f.id
    JOIN rag_document d ON d.id = c.document_id
    ORDER BY f.score DESC
    LIMIT ${p.k}
  `;
}

export async function hybridSearch(p: HybridSearchParams): Promise<HybridSearchResult> {
  // Fuse each arm's top-`cand` candidates, never fewer than the floor — so the #1 result
  // does not depend on how many rows the caller happened to ask for. Scales past the floor
  // for very large k.
  const cand = Math.max(p.k * 4, RRF_POOL_MIN);
  return db().transaction(async (tx) => {
    // pgvector 0.8 iterative scan — keeps ANN recall under a selective tenant filter.
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
    await tx.execute(sql`SET LOCAL hnsw.max_scan_tuples = 20000`);
    // ef_search must be >= the dense candidate pool, or HNSW can't fill it. SET takes no
    // bind params, so inline the computed integer (safe — derived from validated k).
    await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.max(100, cand)))}`);

    const q = rrfQuery(p, cand);
    let explain: string | undefined;
    if (p.explain) {
      const plan = await tx.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q}`,
      );
      explain = (plan as unknown as Array<Record<string, string>>)
        .map((r) => r["QUERY PLAN"])
        .join("\n");
    }
    const raw = (await tx.execute(q)) as unknown as SearchHit[];
    // postgres returns the RRF numeric as a string — coerce to a real number.
    const hits = raw.map((h) => ({ ...h, score: Number(h.score) }));
    return explain ? { hits, explain } : { hits };
  });
}
