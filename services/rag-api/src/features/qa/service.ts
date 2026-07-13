import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { draftQaFromChunk } from "./draft.ts";

/** A QA pair cannot exist (usefully) without a non-empty citation set whose ids all
 *  reference non-rejected chunks in this tenant. Returns the valid chunk rows. */
async function validateCitations(tenant: TenantContext, citationIds: string[]) {
  if (!citationIds.length) throw new Error("citation_ids must be non-empty");
  const rows = await db()
    .select({
      id: schema.ragChunk.id,
      review: schema.ragChunk.review,
      documentId: schema.ragChunk.documentId,
      collection: schema.ragChunk.collection,
    })
    .from(schema.ragChunk)
    .where(
      and(
        inArray(schema.ragChunk.id, citationIds),
        eq(schema.ragChunk.hfId, tenant.hfId),
        eq(schema.ragChunk.companyId, tenant.companyId),
      ),
    );
  if (rows.length !== citationIds.length) {
    throw new Error("some citation_ids do not exist in this tenant");
  }
  const rejected = rows.filter((r) => r.review === "rejected");
  if (rejected.length) throw new Error("citation references a rejected chunk");
  return rows;
}

export async function createDraftFromChunk(tenant: TenantContext, chunkId: string) {
  const [chunk] = await validateCitations(tenant, [chunkId]);
  const [full] = await db()
    .select({ content: schema.ragChunk.content })
    .from(schema.ragChunk)
    .where(eq(schema.ragChunk.id, chunkId))
    .limit(1);
  const drafted = await draftQaFromChunk(full!.content);
  const id = newId();
  await db().insert(schema.laoQaPair).values({
    id,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    collection: chunk!.collection,
    questionLo: drafted.question_lo,
    answerLo: drafted.answer_lo,
    citationIds: [chunkId],
    source: "llm_draft",
    verified: false,
  });
  return { id, ...drafted, source: "llm_draft", verified: false, citationIds: [chunkId] };
}

export interface HumanQaInput {
  questionLo: string;
  answerLo: string;
  questionEn?: string;
  answerEn?: string;
  citationIds: string[];
  tags?: string[];
  difficulty?: number;
  source?: "human" | "chat_promoted";
}

export async function createQa(tenant: TenantContext, input: HumanQaInput) {
  const chunks = await validateCitations(tenant, input.citationIds);
  const id = newId();
  await db().insert(schema.laoQaPair).values({
    id,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    collection: chunks[0]!.collection,
    questionLo: input.questionLo,
    answerLo: input.answerLo,
    questionEn: input.questionEn ?? null,
    answerEn: input.answerEn ?? null,
    citationIds: input.citationIds,
    tags: input.tags ?? [],
    difficulty: input.difficulty ?? 2,
    source: input.source ?? "human",
    verified: false,
  });
  return { id };
}

export async function verifyQa(tenant: TenantContext, id: string, verifiedBy: string) {
  const res = await db()
    .update(schema.laoQaPair)
    .set({ verified: true, verifiedBy, verifiedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.laoQaPair.id, id),
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoQaPair.id });
  return res[0] ?? null;
}

export async function listQa(
  tenant: TenantContext,
  filter: { verified?: boolean; split?: string } = {},
) {
  const conds = [
    eq(schema.laoQaPair.hfId, tenant.hfId),
    eq(schema.laoQaPair.companyId, tenant.companyId),
  ];
  if (filter.verified !== undefined) conds.push(eq(schema.laoQaPair.verified, filter.verified));
  return db()
    .select()
    .from(schema.laoQaPair)
    .where(and(...conds))
    .orderBy(schema.laoQaPair.createdAt);
}

/** Deterministic [0,1) hash so split assignment is stable across runs. */
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Assign splits BY SOURCE DOCUMENT (never by row) so QA from one document never
 *  straddles train/test — otherwise the eval leaks. */
export async function assignSplits(
  tenant: TenantContext,
  ratios: { train: number; dev: number } = { train: 0.7, dev: 0.15 },
) {
  const qas = await db()
    .select({ id: schema.laoQaPair.id, citationIds: schema.laoQaPair.citationIds })
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
        eq(schema.laoQaPair.verified, true),
      ),
    );

  // Map each QA to its source document (first citation's chunk).
  const firstCitations = qas.map((q) => q.citationIds[0]).filter(Boolean) as string[];
  const chunkDocs = firstCitations.length
    ? await db()
        .select({ id: schema.ragChunk.id, documentId: schema.ragChunk.documentId })
        .from(schema.ragChunk)
        .where(inArray(schema.ragChunk.id, firstCitations))
    : [];
  const docOf = new Map(chunkDocs.map((c) => [c.id, c.documentId]));

  const counts = { train: 0, dev: 0, test: 0 };
  for (const q of qas) {
    const doc = docOf.get(q.citationIds[0] ?? "") ?? q.id;
    const u = hashUnit(doc); // whole document → same bucket
    const split = u < ratios.train ? "train" : u < ratios.train + ratios.dev ? "dev" : "test";
    counts[split as keyof typeof counts]++;
    await db()
      .update(schema.laoQaPair)
      .set({ split: split as "train" | "dev" | "test", updatedAt: new Date() })
      .where(eq(schema.laoQaPair.id, q.id));
  }
  return counts;
}

export async function qaStats(tenant: TenantContext) {
  const rows = await db()
    .select({
      verified: schema.laoQaPair.verified,
      split: schema.laoQaPair.split,
      source: schema.laoQaPair.source,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
      ),
    )
    .groupBy(schema.laoQaPair.verified, schema.laoQaPair.split, schema.laoQaPair.source);
  return rows;
}
