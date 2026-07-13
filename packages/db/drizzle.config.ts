import { defineConfig } from "drizzle-kit";

/**
 * Drizzle is the single source of truth for the DB schema — with ONE deliberate
 * exception: the HNSW index on rag_chunk.embedding is created post-bulk-load by
 * `bun run db:index:hnsw`, NOT here. See CLAUDE.md decision (3).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://arnfar:change-me-locally@localhost:5432/arnfar",
  },
  strict: true,
  verbose: true,
});
