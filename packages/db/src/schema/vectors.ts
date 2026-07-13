import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector `halfvec` (float16) — halves the RAM of a full `vector`. bge-m3 is 1024-dim.
 * The HNSW index over this column is created post-bulk-load by `db:index:hnsw`, NOT in
 * the declarative schema (CLAUDE.md decision C).
 */
export const halfvec = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `halfvec(${config?.dimensions ?? 1024})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(",").map(Number);
  },
});

/**
 * Postgres `tsvector`. The `fts` column is GENERATED from `content_seg` (LaoNLP
 * tokens), never queried directly in TS — read-only here.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});
