import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { chunkKind, reviewState } from "./enums.ts";
import { ragDocument } from "./document.ts";
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
    index("rag_chunk_review")
      .on(t.hfId, t.companyId, t.review)
      .where(sql`review = 'pending'`),
    index("rag_chunk_meta_gin").using("gin", sql`meta jsonb_path_ops`),
  ],
);
