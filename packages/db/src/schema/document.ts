import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { docStatus } from "./enums.ts";

/** Source documents. Provenance fields (authority/effective_date/license) are
 *  legally important for an accounting corpus. */
export const ragDocument = pgTable(
  "rag_document",
  {
    id: uuid("id").primaryKey(), // UUIDv7, app-generated
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id"),
    collection: text("collection").notNull(),
    title: text("title").notNull(),
    sourceFilename: text("source_filename").notNull(),
    sourceUri: text("source_uri").notNull(), // storage key of the original .docx
    lang: text("lang").notNull(),
    status: docStatus("status").notNull().default("uploaded"),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    authority: text("authority"),
    effectiveDate: date("effective_date"),
    supersededBy: uuid("superseded_by"),
    license: text("license").notNull().default("internal"),
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("rag_document_tenant_sha").on(
      t.hfId,
      t.companyId,
      t.collection,
      t.contentSha256,
    ),
    check("rag_document_lang_chk", sql`${t.lang} IN ('lo','en','th','mixed')`),
    // Self-reference: a document may be superseded by another.
    foreignKey({
      columns: [t.supersededBy],
      foreignColumns: [t.id],
      name: "rag_document_superseded_by_fk",
    }),
  ],
);
