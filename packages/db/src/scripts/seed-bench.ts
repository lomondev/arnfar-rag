/** Seed synthetic bulk chunks under an isolated bench tenant so the planner will
 *  choose the HNSW index (a 12-row table is always a seq scan). Lets Phase 4 prove
 *  Index Scan under a tenant filter and measure p95. Drop with seed-bench.ts --drop.
 *
 *  Usage: bun run src/scripts/seed-bench.ts [count]   (default 3000)
 *         bun run src/scripts/seed-bench.ts --drop
 */
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ?? "postgres://arnfar:change-me-locally@localhost:5433/arnfar";
const sql = postgres(url, { max: 1 });

const BENCH_HF = "018f0000-0000-7000-8000-0000000000bb";
const BENCH_CO = "018f0000-0000-7000-8000-0000000000cc";
const BENCH_DOC = "018f0000-0000-7000-8000-0000000000dd";

try {
  if (process.argv.includes("--drop")) {
    await sql`DELETE FROM rag_document WHERE id = ${BENCH_DOC}`;
    console.log("dropped bench data");
  } else {
    const count = Number(process.argv[2] ?? 3000);
    await sql`
      INSERT INTO rag_document (id, hf_id, company_id, collection, title, source_filename,
                                source_uri, lang, status, content_sha256, license, meta)
      VALUES (${BENCH_DOC}, ${BENCH_HF}, ${BENCH_CO}, 'bench', 'bench', 'bench.docx',
              'bench', 'lo', 'embedded', repeat('b', 64), 'internal', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`;

    // CROSS JOIN LATERAL re-evaluates the random-vector subquery per row of g
    // (volatile random() → a fresh 1024-dim vector for each chunk).
    await sql`
      INSERT INTO rag_chunk (id, document_id, hf_id, company_id, collection, seq, kind,
                             content, content_norm, content_seg, lang, token_count,
                             embedding, review, meta)
      SELECT gen_random_uuid(), ${BENCH_DOC}, ${BENCH_HF}, ${BENCH_CO}, 'bench', g, 'prose',
             'ທົດສອບ ບັນຊີ ' || g, 'ທົດສອບ ບັນຊີ ' || g, 'ທົດສອບ ບັນຊີ ' || g, 'lo', 5,
             v.emb, 'accepted', '{}'::jsonb
      FROM generate_series(1, ${count}) g
      CROSS JOIN LATERAL (
        SELECT ('[' || string_agg(random()::text, ',') || ']')::halfvec AS emb
        FROM generate_series(1, 1024)
      ) v`;

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int n FROM rag_chunk WHERE hf_id = ${BENCH_HF}`;
    console.log(`bench chunks now: ${rows[0]?.n ?? 0}`);
  }
} finally {
  await sql.end();
}
