import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, asc, desc, eq, lt } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";

/** Append an outbox audit event (no broker consumer — decision B). */
async function auditEvent(
  tenant: TenantContext,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await db().insert(schema.outboxEvent).values({
    id: newId(),
    hfId: tenant.hfId,
    aggregateType,
    aggregateId,
    eventType,
    payload,
  });
}

/**
 * Conversation CRUD + message persistence. Replaces the browser-localStorage
 * history (apps/web/src/features/chat/storage.ts) with server-side state so the
 * assistant can do real multi-turn RAG and users get cross-device history.
 *
 * Every query carries the tenant filter (CLAUDE.md multi-tenancy rule).
 */

const LIST_LIMIT = 100;
/** How many prior messages to load into the LLM context window per turn. */
export const CONTEXT_WINDOW = 8;
/** Max chars of a prior assistant turn to include — old answers must not eat the budget. */
const MAX_HISTORY_ANSWER_CHARS = 300;

export interface ConversationRow {
  id: string;
  title: string;
  lang: string;
  collection: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  sources: unknown | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationDetail extends ConversationRow {
  messages: MessageRow[];
}

/** First line of the opening question, clipped. Lao has no spaces, so clip on graphemes. */
export function titleFrom(question: string): string {
  const line = question.trim().split("\n")[0] ?? "";
  const chars = [...line];
  if (chars.length === 0) return "New chat";
  return chars.length > 48 ? `${chars.slice(0, 48).join("")}…` : line;
}

function tenantCond(t: TenantContext) {
  return and(eq(schema.ragConversation.hfId, t.hfId), eq(schema.ragConversation.companyId, t.companyId));
}

export async function createConversation(
  tenant: TenantContext,
  input: { title?: string; lang?: string; collection?: string },
): Promise<ConversationRow> {
  const id = newId();
  const now = new Date();
  await db().insert(schema.ragConversation).values({
    id,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    branchId: tenant.branchId ?? null,
    title: input.title ?? "New chat",
    lang: input.lang ?? "mixed",
    collection: input.collection ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await auditEvent(tenant, "conversation", id, "conversation.created", { title: input.title ?? "New chat" });
  return {
    id,
    title: input.title ?? "New chat",
    lang: input.lang ?? "mixed",
    collection: input.collection ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function listConversations(tenant: TenantContext): Promise<ConversationRow[]> {
  const rows = await db()
    .select({
      id: schema.ragConversation.id,
      title: schema.ragConversation.title,
      lang: schema.ragConversation.lang,
      collection: schema.ragConversation.collection,
      createdAt: schema.ragConversation.createdAt,
      updatedAt: schema.ragConversation.updatedAt,
    })
    .from(schema.ragConversation)
    .where(tenantCond(tenant))
    .orderBy(desc(schema.ragConversation.updatedAt))
    .limit(LIST_LIMIT);
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getConversation(tenant: TenantContext, id: string): Promise<ConversationDetail | null> {
  const [conv] = await db()
    .select({
      id: schema.ragConversation.id,
      title: schema.ragConversation.title,
      lang: schema.ragConversation.lang,
      collection: schema.ragConversation.collection,
      createdAt: schema.ragConversation.createdAt,
      updatedAt: schema.ragConversation.updatedAt,
    })
    .from(schema.ragConversation)
    .where(and(eq(schema.ragConversation.id, id), tenantCond(tenant)))
    .limit(1);
  if (!conv) return null;

  const messages = await db()
    .select({
      id: schema.ragMessage.id,
      conversationId: schema.ragMessage.conversationId,
      role: schema.ragMessage.role,
      content: schema.ragMessage.content,
      sources: schema.ragMessage.sources,
      meta: schema.ragMessage.meta,
      createdAt: schema.ragMessage.createdAt,
    })
    .from(schema.ragMessage)
    .where(
      and(
        eq(schema.ragMessage.conversationId, id),
        eq(schema.ragMessage.hfId, tenant.hfId),
        eq(schema.ragMessage.companyId, tenant.companyId),
      ),
    )
    .orderBy(asc(schema.ragMessage.createdAt));

  return {
    ...conv,
    createdAt: conv.createdAt.toISOString(),
    updatedAt: conv.updatedAt.toISOString(),
    messages: messages.map((m) => ({
      ...m,
      role: m.role as "user" | "assistant",
      meta: m.meta as Record<string, unknown>,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function renameConversation(
  tenant: TenantContext,
  id: string,
  patch: { title?: string; lang?: string; collection?: string | null },
): Promise<ConversationRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.lang !== undefined) set.lang = patch.lang;
  if (patch.collection !== undefined) set.collection = patch.collection;
  const rows = await db()
    .update(schema.ragConversation)
    .set(set)
    .where(and(eq(schema.ragConversation.id, id), tenantCond(tenant)))
    .returning({
      id: schema.ragConversation.id,
      title: schema.ragConversation.title,
      lang: schema.ragConversation.lang,
      collection: schema.ragConversation.collection,
      createdAt: schema.ragConversation.createdAt,
      updatedAt: schema.ragConversation.updatedAt,
    });
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function deleteConversation(tenant: TenantContext, id: string): Promise<boolean> {
  const rows = await db()
    .delete(schema.ragConversation)
    .where(and(eq(schema.ragConversation.id, id), tenantCond(tenant)))
    .returning({ id: schema.ragConversation.id });
  return rows.length > 0;
}

/** Insert a message. Called for both user turns and assistant turns. */
export async function insertMessage(
  tenant: TenantContext,
  input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    sources?: unknown;
    meta?: Record<string, unknown>;
  },
): Promise<MessageRow> {
  const id = newId();
  const now = new Date();
  await db().insert(schema.ragMessage).values({
    id,
    conversationId: input.conversationId,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    role: input.role,
    content: input.content,
    sources: input.sources ?? null,
    meta: input.meta ?? {},
    createdAt: now,
  });
  // Bump the conversation's updatedAt so the sidebar reorders.
  await db()
    .update(schema.ragConversation)
    .set({ updatedAt: now })
    .where(eq(schema.ragConversation.id, input.conversationId));
  // Audit trail — every message is logged for liability / analytics.
  await auditEvent(tenant, "conversation", input.conversationId, "message.created", {
    role: input.role,
    contentLength: input.content.length,
    hasSources: !!input.sources,
  });
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    sources: input.sources ?? null,
    meta: input.meta ?? {},
    createdAt: now.toISOString(),
  };
}

/** Load the last N messages of a conversation for multi-turn context injection.
 *  Ordered oldest → newest so the prompt reads chronologically. */
export async function recentMessages(
  tenant: TenantContext,
  conversationId: string,
  limit = CONTEXT_WINDOW,
): Promise<MessageRow[]> {
  // Sub-select the latest `limit` rows, then re-order ascending for the prompt.
  const recent = await db()
    .select({
      id: schema.ragMessage.id,
      conversationId: schema.ragMessage.conversationId,
      role: schema.ragMessage.role,
      content: schema.ragMessage.content,
      sources: schema.ragMessage.sources,
      meta: schema.ragMessage.meta,
      createdAt: schema.ragMessage.createdAt,
    })
    .from(schema.ragMessage)
    .where(
      and(
        eq(schema.ragMessage.conversationId, conversationId),
        eq(schema.ragMessage.hfId, tenant.hfId),
        eq(schema.ragMessage.companyId, tenant.companyId),
      ),
    )
    .orderBy(desc(schema.ragMessage.createdAt))
    .limit(limit);

  return recent
    .reverse()
    .map((m) => ({
      ...m,
      role: m.role as "user" | "assistant",
      meta: m.meta as Record<string, unknown>,
      createdAt: m.createdAt.toISOString(),
    }));
}

/** Trim a prior assistant turn so old answers don't consume the context budget.
 *  The full answer is still in the DB for the UI; only the prompt copy is shortened. */
export function trimForHistory(role: "user" | "assistant", content: string): string {
  if (role === "user") return content;
  const chars = [...content];
  return chars.length > MAX_HISTORY_ANSWER_CHARS
    ? `${chars.slice(0, MAX_HISTORY_ANSWER_CHARS).join("")}…`
    : content;
}

/** Older conversations beyond the list cap — used by a future cleanup job. Not
 *  exposed in routes yet; included so the tenant filter pattern is obvious. */
export async function oldConversationsBefore(tenant: TenantContext, before: Date) {
  return db()
    .select({ id: schema.ragConversation.id })
    .from(schema.ragConversation)
    .where(and(tenantCond(tenant), lt(schema.ragConversation.updatedAt, before)));
}
