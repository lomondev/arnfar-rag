import type { TenantContext } from "@arnfar/db";
import { type SQL, sql } from "drizzle-orm";

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
  /** Non-null when this chunk's document has been replaced by a newer one. The document
   *  stays retrievable; the citation carries the warning. */
  superseded_by_title: string | null;
  superseded_by_effective_date: string | null;
  score: number;
}

export interface HybridSearchParams {
  tenant: TenantContext;
  collections: string[];
  /** Scope to knowledge kinds (chunk meta.knowledge_kind). Empty = no kind filter. */
  kinds: string[];
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
export const RRF_POOL_MIN = 100;

/** Rows each arm fuses for a requested page size `k`. Exported so the eval harness sizes
 *  its baselines the same way production does — a hand-copied constant drifts, and then a
 *  run reports numbers for a retriever that never served a user. */
export function candidatePool(k: number): number {
  return Math.max(k * 4, RRF_POOL_MIN);
}

/** Anything that can run SQL — a Drizzle client or a transaction handle. */
interface Executor {
  execute(query: SQL): Promise<unknown>;
}

/** pgvector 0.8 scan settings for an ANN query. MUST be applied inside the same
 *  transaction as the query (SET LOCAL). Iterative scan is what keeps recall up under a
 *  selective tenant filter, and ef_search has to reach the candidate pool or HNSW simply
 *  cannot fill it. Shared with eval so both measure the same scan behaviour. */
export async function applyAnnSessionSettings(tx: Executor, cand: number): Promise<void> {
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
  await tx.execute(sql`SET LOCAL hnsw.max_scan_tuples = 20000`);
  // SET takes no bind params, so inline the computed integer (safe — derived from k).
  await tx.execute(
    sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.max(RRF_POOL_MIN, cand)))}`,
  );
}

function rrfQuery(p: HybridSearchParams, cand: number) {
  const vec = `[${p.queryEmbedding.join(",")}]`;
  // Collections are user-creatable now — an empty list means "no collection filter"
  // (tenant + review guards still apply), so entries in novel collections are reachable.
  const collPred = p.collections.length
    ? sql`AND collection IN (${sql.join(
        p.collections.map((c) => sql`${c}`),
        sql`, `,
      )})`
    : sql``;
  // Kind scoping reads the chunk's own meta — no rag_document join inside the ANN CTEs.
  const kindPred = p.kinds.length
    ? sql`AND meta ->> 'knowledge_kind' IN (${sql.join(
        p.kinds.map((x) => sql`${x}`),
        sql`, `,
      )})`
    : sql``;
  return sql`
    WITH dense AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vec}::halfvec) AS rank
      FROM rag_chunk
      WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
        ${collPred}
        ${kindPred}
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
        ${kindPred}
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
           d.title, d.authority, d.effective_date,
           sd.title AS superseded_by_title,
           sd.effective_date AS superseded_by_effective_date,
           f.score::float8 AS score
    FROM fused f
    JOIN rag_chunk c ON c.id = f.id
    JOIN rag_document d ON d.id = c.document_id
    -- Left join: most documents are current, and a superseded one must still be returned
    -- (old law answers historical questions) — it just travels with its replacement named.
    LEFT JOIN rag_document sd ON sd.id = d.superseded_by
    ORDER BY f.score DESC
    LIMIT ${p.k}
  `;
}

export async function hybridSearch(p: HybridSearchParams): Promise<HybridSearchResult> {
  // Fuse each arm's top-`cand` candidates, never fewer than the floor — so the #1 result
  // does not depend on how many rows the caller happened to ask for. Scales past the floor
  // for very large k.
  const cand = candidatePool(p.k);
  return db().transaction(async (tx) => {
    await applyAnnSessionSettings(tx, cand);

    const q = rrfQuery(p, cand);
    let explain: string | undefined;
    if (p.explain) {
      const plan = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q}`);
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
