import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Conversations — server-side persistence for multi-turn chat (replaces the
 * browser-localStorage history in apps/web/src/features/chat/storage.ts).
 *
 * A conversation groups an ordered sequence of messages. The tenant columns are
 * denormalized onto rag_message too so every query can filter by tenant without a
 * join (CLAUDE.md multi-tenancy rule).
 */

/** A chat thread. Title is derived from the first user question. */
export const ragConversation = pgTable(
  "rag_conversation",
  {
    id: uuid("id").primaryKey(), // UUIDv7, app-generated
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id"),
    title: text("title").notNull(),
    // Bilingual support: a conversation's dominant language. Defaults to "mixed".
    lang: text("lang").notNull().default("mixed"),
    // Optional default scope carried into each retrieval (e.g. "coa", "tax").
    collection: text("collection"),
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Bumped on every new message — drives the sidebar ordering.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rag_conversation_tenant_updated").on(t.hfId, t.companyId, t.updatedAt),
    check("rag_conversation_lang_chk", sql`${t.lang} IN ('lo','en','th','mixed')`),
  ],
);

/** A single message within a conversation. role is text (only 'user' | 'assistant'). */
export const ragMessage = pgTable(
  "rag_message",
  {
    id: uuid("id").primaryKey(), // UUIDv7, app-generated
    conversationId: uuid("conversation_id").notNull(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Citation sources (assistant turns only). Mirrors the CitationSource shape
    // from chat/prompt.ts — stored so a reloaded thread renders [n] chips.
    sources: jsonb("sources"),
    // Model, latency_ms, k, collections, glossaryMatches — flexible per-turn metadata.
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rag_message_conversation_created").on(t.conversationId, t.createdAt),
    index("rag_message_tenant").on(t.hfId, t.companyId),
    index("rag_message_meta_gin").using("gin", sql`meta jsonb_path_ops`),
    check("rag_message_role_chk", sql`${t.role} IN ('user','assistant')`),
    foreignKey({
      columns: [t.conversationId],
      foreignColumns: [ragConversation.id],
      name: "rag_message_conversation_fk",
    }).onDelete("cascade"),
  ],
);
