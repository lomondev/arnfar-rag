import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { ragDocument } from "./document.ts";
import { chunkKind, reviewState } from "./enums.ts";
import { halfvec, tsvector } from "./vectors.ts";

/** Chunks — the retrieval unit. hf_id/company_id are denormalized so tenant
 *  filtering needs no join. content is ORIGINAL and never mutated; content_norm
 *  feeds the embedding; content_seg feeds the tsvector. */
export const ragChunk = pgTable(
  "rag_chunk",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    documentId: uuid("document_id")
      .notNull()
      .references(() => ragDocument.id, { onDelete: "cascade" }),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id"),
    collection: text("collection").notNull(),
    seq: integer("seq").notNull(),
    kind: chunkKind("kind").notNull().default("prose"),

    content: text("content").notNull(), // ORIGINAL — never mutated except human edit
    contentNorm: text("content_norm").notNull(), // NFC, ZWSP-stripped → embedding input
    contentSeg: text("content_seg").notNull(), // LaoNLP tokens → tsvector input
    headingPath: text("heading_path").array().notNull().default(sql`'{}'::text[]`),
    pageHint: integer("page_hint"),

    lang: text("lang").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: halfvec("embedding", { dimensions: 1024 }), // nullable until embedded
    /**
     * The Ollama model that produced `embedding` — provenance, not decoration.
     *
     * OLLAMA_EMBED_MODEL is configurable, and vectors from two different models share no
     * geometry: a cosine distance between a bge-m3 vector and a multilingual-e5-large one
     * is noise, not similarity. Both are 1024-dim, so `halfvec(1024)` does not catch it and
     * the ANN index accepts them side by side. Without this column that mix is undetectable
     * and recall collapses silently — the failure CLAUDE.md warns about, one layer down.
     *
     * NULL means one of two things, distinguished by `embedding`: not embedded yet, or
     * embedded before this column existed (provenance unknown — `bun run db:reembed`).
     */
    embedModel: text("embed_model"),
    fts: tsvector("fts").generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`to_tsvector('simple', content_seg)`,
    ),

    review: reviewState("review").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("rag_chunk_document_seq").on(t.documentId, t.seq),
    // HNSW index is created post-load by db:index:hnsw (decision C) — NOT here.
    index("rag_chunk_fts_gin").using("gin", t.fts),
    index("rag_chunk_tenant").on(t.hfId, t.companyId, t.collection),
    index("rag_chunk_review").on(t.hfId, t.companyId, t.review).where(sql`review = 'pending'`),
    index("rag_chunk_meta_gin").using("gin", sql`meta jsonb_path_ops`),
    // Makes the provenance census (`GROUP BY embed_model`) an index-only scan instead of a
    // heap scan over every chunk — it runs at every boot.
    index("rag_chunk_embed_model")
      .on(t.embedModel)
      .where(sql`embed_model IS NOT NULL`),
    // A model name with no vector is not a state this system has: provenance is written in
    // the same UPDATE as the vector it describes. Enforced here rather than trusted.
    check("rag_chunk_embed_model_needs_vector", sql`embedding IS NOT NULL OR embed_model IS NULL`),
  ],
);
