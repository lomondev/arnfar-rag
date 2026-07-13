/**
 * Build the HNSW index on rag_chunk.embedding AFTER a bulk embed load.
 *
 * Deliberately NOT part of the declarative Drizzle schema (CLAUDE.md decision 3):
 * bulk-inserting into a live HNSW index is ~10x slower, so we load embeddings first,
 * then build the index once. Idempotent — safe to re-run.
 *
 * Usage: bun run db:index:hnsw
 */
import postgres from "postgres";

const url =
  process.env.DATABASE_URL ?? "postgres://arnfar:change-me-locally@localhost:5432/arnfar";

const sql = postgres(url, { max: 1 });

try {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'rag_chunk'
    ) AS exists
  `;
  const exists = rows[0]?.exists ?? false;

  if (!exists) {
    console.log(
      "rag_chunk does not exist yet — schema phase has not landed. Nothing to index.",
    );
  } else {
    console.log("Building HNSW index rag_chunk_embedding_hnsw (halfvec_cosine_ops)…");
    // m=16, ef_construction=96 per spec §4. IF NOT EXISTS keeps it idempotent.
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS rag_chunk_embedding_hnsw
        ON rag_chunk USING hnsw (embedding halfvec_cosine_ops)
        WITH (m = 16, ef_construction = 96)
    `);
    console.log("Done. Remember to ANALYZE rag_chunk after a large load.");
  }
} finally {
  await sql.end({ timeout: 5 });
}
