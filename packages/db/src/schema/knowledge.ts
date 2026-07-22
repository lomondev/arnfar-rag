import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/** User-defined knowledge kinds — the categories of the /studio/knowledge menu
 *  (tax rates, procedures, policies, FAQs — whatever the curator needs).
 *
 *  Entries themselves are NOT a separate table: each entry is a rag_document
 *  (meta.knowledge_kind = key) with real chunks — cleaned, segmented, embedded —
 *  so manual knowledge flows through the exact same retrieval, review, and export
 *  invariants as ingested documents. A kind only points entries at a collection. */
export const knowledgeKind = pgTable(
  "knowledge_kind",
  {
    id: uuid("id").primaryKey(), // UUIDv7, app-generated
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    /** Stable slug used in rag_document.meta.knowledge_kind (ascii, kebab-case). */
    key: text("key").notNull(),
    nameLo: text("name_lo").notNull(),
    nameEn: text("name_en"),
    description: text("description"),
    /** Which retrieval collection entries land in. Must be one of the collections the
     *  search layer queries by default — a novel collection name would be invisible
     *  to chat retrieval. */
    collection: text("collection").notNull().default("sop"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("knowledge_kind_tenant_key").on(t.hfId, t.companyId, t.key)],
);
