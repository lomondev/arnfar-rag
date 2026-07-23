import { schema } from "@arnfar/db";
import type { TenantContext } from "@arnfar/db";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";

/** Studio home aggregations. Read-only; every query tenant-scoped. */

export interface Overview {
  corpus: {
    documents: number;
    chunks: number;
    embedded: number;
    review: { pending: number; accepted: number; rejected: number };
    byCollection: { collection: string; chunks: number; accepted: number }[];
    avgTokens: number;
  };
  dataset: {
    qa: { total: number; verified: number };
    terms: { total: number; verified: number };
    accounts: { total: number; verified: number };
  };
  chat: { conversations: number; messages: number };
  activity: { eventType: string; createdAt: string; summary: string }[];
}

export async function overview(tenant: TenantContext): Promise<Overview> {
  const chunkWhere = and(
    eq(schema.ragChunk.hfId, tenant.hfId),
    eq(schema.ragChunk.companyId, tenant.companyId),
  );

  const [docs] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
      ),
    );

  const [chunkAgg] = await db()
    .select({
      chunks: sql<number>`count(*)::int`,
      embedded: sql<number>`count(*) FILTER (WHERE embedding IS NOT NULL)::int`,
      pending: sql<number>`count(*) FILTER (WHERE review = 'pending')::int`,
      accepted: sql<number>`count(*) FILTER (WHERE review = 'accepted')::int`,
      rejected: sql<number>`count(*) FILTER (WHERE review = 'rejected')::int`,
      avgTokens: sql<number>`coalesce(round(avg(token_count)),0)::int`,
    })
    .from(schema.ragChunk)
    .where(chunkWhere);

  const byCollection = await db()
    .select({
      collection: schema.ragChunk.collection,
      chunks: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) FILTER (WHERE review = 'accepted')::int`,
    })
    .from(schema.ragChunk)
    .where(chunkWhere)
    .groupBy(schema.ragChunk.collection)
    .orderBy(sql`count(*) desc`);

  const counted = async (table: typeof schema.laoQaPair | typeof schema.laoTerm | typeof schema.laoAccount) => {
    const [r] = await db()
      .select({
        total: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) FILTER (WHERE verified)::int`,
      })
      .from(table)
      .where(and(eq(table.hfId, tenant.hfId), eq(table.companyId, tenant.companyId)));
    return { total: r?.total ?? 0, verified: r?.verified ?? 0 };
  };

  const [convAgg] = await db()
    .select({
      conversations: sql<number>`count(distinct conversation_id)::int`,
      messages: sql<number>`count(*)::int`,
    })
    .from(schema.ragMessage)
    .where(
      and(
        eq(schema.ragMessage.hfId, tenant.hfId),
        eq(schema.ragMessage.companyId, tenant.companyId),
      ),
    );

  const events = await db()
    .select({
      eventType: schema.outboxEvent.eventType,
      createdAt: schema.outboxEvent.createdAt,
      payload: schema.outboxEvent.payload,
    })
    .from(schema.outboxEvent)
    .where(eq(schema.outboxEvent.hfId, tenant.hfId))
    .orderBy(desc(schema.outboxEvent.createdAt))
    .limit(8);

  return {
    corpus: {
      documents: docs?.n ?? 0,
      chunks: chunkAgg?.chunks ?? 0,
      embedded: chunkAgg?.embedded ?? 0,
      review: {
        pending: chunkAgg?.pending ?? 0,
        accepted: chunkAgg?.accepted ?? 0,
        rejected: chunkAgg?.rejected ?? 0,
      },
      byCollection,
      avgTokens: chunkAgg?.avgTokens ?? 0,
    },
    dataset: {
      qa: await counted(schema.laoQaPair),
      terms: await counted(schema.laoTerm),
      accounts: await counted(schema.laoAccount),
    },
    chat: {
      conversations: convAgg?.conversations ?? 0,
      messages: convAgg?.messages ?? 0,
    },
    activity: events.map((e) => ({
      eventType: e.eventType,
      createdAt: e.createdAt.toISOString(),
      summary: JSON.stringify(e.payload).slice(0, 120),
    })),
  };
}

export interface Gaps {
  /** Assistant turns that did not cite anything — the model abstained (or answered
   *  ungrounded). Each carries the user question it failed, newest first. */
  abstained: { question: string; answer: string; conversationId: string; at: string }[];
  /** Chunks flagged by Report-wrong / the teach ຜິດ button — a re-review queue. */
  reported: { id: string; excerpt: string; collection: string; title: string }[];
}

export async function gaps(tenant: TenantContext): Promise<Gaps> {
  // An answer with no [n] marker never cited a chunk. The preceding user message in the
  // same conversation is the question the dataset could not answer — the work list.
  const abstainedRows = (await db().execute(sql`
    SELECT m.conversation_id, m.content AS answer, m.created_at,
           (SELECT u.content FROM rag_message u
             WHERE u.conversation_id = m.conversation_id
               AND u.role = 'user' AND u.created_at < m.created_at
             ORDER BY u.created_at DESC LIMIT 1) AS question
    FROM rag_message m
    WHERE m.hf_id = ${tenant.hfId} AND m.company_id = ${tenant.companyId}
      AND m.role = 'assistant'
      AND m.content !~ '\\[[0-9]+\\]'
    ORDER BY m.created_at DESC
    LIMIT 10
  `)) as unknown as {
    conversation_id: string;
    answer: string;
    created_at: string | Date;
    question: string | null;
  }[];

  const reportedRows = await db()
    .select({
      id: schema.ragChunk.id,
      content: schema.ragChunk.content,
      collection: schema.ragChunk.collection,
      title: schema.ragDocument.title,
    })
    .from(schema.ragChunk)
    .innerJoin(schema.ragDocument, eq(schema.ragChunk.documentId, schema.ragDocument.id))
    .where(
      and(
        eq(schema.ragChunk.hfId, tenant.hfId),
        eq(schema.ragChunk.companyId, tenant.companyId),
        sql`${schema.ragChunk.meta} ->> 'reported' = 'true'`,
      ),
    )
    .limit(10);

  return {
    abstained: abstainedRows
      .filter((r) => r.question)
      .map((r) => ({
        question: r.question!,
        answer: r.answer.slice(0, 160),
        conversationId: r.conversation_id,
        at: new Date(r.created_at).toISOString(),
      })),
    reported: reportedRows.map((r) => ({
      id: r.id,
      excerpt: r.content.slice(0, 120),
      collection: r.collection,
      title: r.title,
    })),
  };
}
