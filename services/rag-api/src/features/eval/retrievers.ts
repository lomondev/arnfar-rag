import type { TenantContext } from "@arnfar/db";
import { sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";

export type Retriever = "dense" | "lexical" | "hybrid-rrf";

export interface RetrieveParams {
  tenant: TenantContext;
  collections: string[];
  queryEmbedding: number[];
  querySeg: string;
  k: number;
}

function collList(collections: string[]) {
  return sql.join(
    collections.map((c) => sql`${c}`),
    sql`, `,
  );
}

/** Return chunk ids in rank order for a retrieval mode. All modes carry the tenant
 *  predicate and exclude rejected chunks (CLAUDE.md). */
export async function retrieve(mode: Retriever, p: RetrieveParams): Promise<string[]> {
  const vec = `[${p.queryEmbedding.join(",")}]`;
  const cols = collList(p.collections);

  return db().transaction(async (tx) => {
    if (mode !== "lexical") {
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`);
    }

    if (mode === "dense") {
      const rows = (await tx.execute(sql`
        SELECT id FROM rag_chunk
        WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
          AND collection IN (${cols}) AND review <> 'rejected' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::halfvec
        LIMIT ${p.k}
      `)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    if (mode === "lexical") {
      const rows = (await tx.execute(sql`
        SELECT id FROM rag_chunk
        WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
          AND collection IN (${cols}) AND review <> 'rejected'
          AND fts @@ plainto_tsquery('simple', ${p.querySeg})
        ORDER BY ts_rank_cd(fts, plainto_tsquery('simple', ${p.querySeg})) DESC
        LIMIT ${p.k}
      `)) as unknown as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }

    // hybrid-rrf (k=60)
    const cand = p.k * 4;
    const rows = (await tx.execute(sql`
      WITH dense AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vec}::halfvec) AS rank
        FROM rag_chunk
        WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
          AND collection IN (${cols}) AND review <> 'rejected' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::halfvec LIMIT ${cand}
      ),
      lexical AS (
        SELECT id, ROW_NUMBER() OVER (
                 ORDER BY ts_rank_cd(fts, plainto_tsquery('simple', ${p.querySeg})) DESC) AS rank
        FROM rag_chunk
        WHERE hf_id = ${p.tenant.hfId} AND company_id = ${p.tenant.companyId}
          AND collection IN (${cols}) AND review <> 'rejected'
          AND fts @@ plainto_tsquery('simple', ${p.querySeg})
        LIMIT ${cand}
      ),
      fused AS (
        SELECT COALESCE(d.id, l.id) AS id,
               COALESCE(1.0/(60+d.rank),0.0) + COALESCE(1.0/(60+l.rank),0.0) AS score
        FROM dense d FULL OUTER JOIN lexical l USING (id)
      )
      SELECT id FROM fused ORDER BY score DESC LIMIT ${p.k}
    `)) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  });
}
