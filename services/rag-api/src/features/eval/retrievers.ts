import type { TenantContext } from "@arnfar/db";
import { sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { applyAnnSessionSettings, candidatePool, hybridSearch } from "../search/query.ts";

export type Retriever = "dense" | "lexical" | "hybrid-rrf";

export interface RetrieveParams {
  tenant: TenantContext;
  collections: string[];
  queryEmbedding: number[];
  querySeg: string;
  k: number;
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
