/** Phase 4 bench: prove HNSW Index Scan under the tenant filter + measure p95.
 *  Runs against the synthetic bench tenant (seed-bench.ts). */
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ?? "postgres://arnfar:change-me-locally@localhost:5433/arnfar";
const sql = postgres(url, { max: 1 });

const HF = "018f0000-0000-7000-8000-0000000000bb";
const CO = "018f0000-0000-7000-8000-0000000000cc";

function randomVec(): string {
  const a = new Array(1024);
  for (let i = 0; i < 1024; i++) a[i] = Math.random().toFixed(6);
  return `[${a.join(",")}]`;
}

try {
  await sql`ANALYZE rag_chunk`;

  // EXPLAIN the dense CTE under the tenant filter.
  const vec = randomVec();
  const plan = await sql.begin(async (tx) => {
    await tx`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`;
    await tx`SET LOCAL hnsw.max_scan_tuples = 20000`;
    await tx`SET LOCAL hnsw.ef_search = 100`;
    return tx`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vec}::halfvec) AS rank
      FROM rag_chunk
      WHERE hf_id = ${HF} AND company_id = ${CO} AND collection IN ('bench')
        AND review <> 'rejected' AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::halfvec
      LIMIT 32`;
  });
  const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
  console.log("=== dense CTE plan (tenant-filtered) ===");
  console.log(planText);
  console.log(
    planText.includes("rag_chunk_embedding_hnsw")
      ? "\n✅ Index Scan using rag_chunk_embedding_hnsw — HNSW used under tenant filter"
      : "\n❌ HNSW NOT used (Seq Scan) — tenant predicate defeated the ANN index",
  );

  // p95 over N dense searches.
  const N = 60;
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const v = randomVec();
    const t0 = performance.now();
    await sql.begin(async (tx) => {
      await tx`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`;
      await tx`SET LOCAL hnsw.ef_search = 100`;
      await tx`
        SELECT id FROM rag_chunk
        WHERE hf_id = ${HF} AND company_id = ${CO} AND collection IN ('bench')
          AND review <> 'rejected' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${v}::halfvec LIMIT 32`;
    });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.floor((p / 100) * times.length)]!.toFixed(1);
  const nRows = await sql<{ n: number }[]>`SELECT count(*)::int n FROM rag_chunk`;
  console.log(`\n=== latency over ${N} dense searches (total rag_chunk rows: ${nRows[0]?.n ?? 0}) ===`);
  console.log(`p50 ${pct(50)}ms · p95 ${pct(95)}ms · p99 ${pct(99)}ms`);
} finally {
  await sql.end();
}
