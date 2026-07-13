import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { jobStatus } from "./enums.ts";
import { ragDocument } from "./document.ts";

/** Ingestion job queue — replaces RabbitMQ (CLAUDE.md decision B). Workers claim
 *  rows with SELECT ... FOR UPDATE SKIP LOCKED. Embedding is idempotent and
 *  resumable; a crashed job is retried from WHERE embedding IS NULL. */
export const ingestJob = pgTable(
  "ingest_job",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").references(() => ragDocument.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(), // 'ingest' | 'embed'
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Queue poll: claim the oldest runnable job.
    index("ingest_job_claim")
      .on(t.runAfter)
      .where(sql`status IN ('queued','running')`),
    index("ingest_job_document").on(t.documentId),
  ],
);
