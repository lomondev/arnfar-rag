import { schema } from "@arnfar/db";
import type { TenantContext } from "@arnfar/db";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { normalize, segment } from "../../lib/sidecars.ts";
import { sha256 } from "../../lib/storage.ts";
import { chunkBlocks, type SegBlock } from "../ingest/chunker.ts";
import { citedQaCount, deleteDocument } from "../ingest/clean-corpus.ts";
import { fixLaoDefects } from "../lao/clean.ts";

/** Knowledge menu backend. A "kind" is a user-defined category; an "entry" is a
 *  rag_document (meta.knowledge_kind = kind.key) whose body was cleaned, chunked,
 *  segmented and embedded through the same machinery as ingested files — so manual
 *  knowledge is retrievable, reviewable, and exportable with zero new paths.
 *
 *  Entry chunks are review='accepted' at creation: the curator writing the entry IS
 *  the human reviewer (same policy as teach-mode auto-verify). */

/* ── kinds ────────────────────────────────────────────────────────────────── */

export interface KindInput {
  key: string;
  nameLo: string;
  nameEn?: string;
  description?: string;
  collection?: string;
}

export async function listKinds(tenant: TenantContext) {
  const kinds = await db()
    .select()
    .from(schema.knowledgeKind)
    .where(
      and(
        eq(schema.knowledgeKind.hfId, tenant.hfId),
        eq(schema.knowledgeKind.companyId, tenant.companyId),
      ),
    )
    .orderBy(schema.knowledgeKind.createdAt);

  // Entry counts per kind in one grouped query.
  const counts = await db()
    .select({
      key: sql<string>`meta ->> 'knowledge_kind'`,
      entries: sql<number>`count(*)::int`,
    })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
        sql`meta ? 'knowledge_kind'`,
      ),
    )
    .groupBy(sql`meta ->> 'knowledge_kind'`);
  const byKey = new Map(counts.map((c) => [c.key, c.entries]));

  return kinds.map((k) => ({ ...k, entries: byKey.get(k.key) ?? 0 }));
}

/** Returns null when the key already exists for this tenant. */
export async function createKind(tenant: TenantContext, input: KindInput) {
  const id = newId();
  const inserted = await db()
    .insert(schema.knowledgeKind)
    .values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      key: input.key,
      nameLo: input.nameLo,
      nameEn: input.nameEn ?? null,
      description: input.description ?? null,
      collection: input.collection ?? "sop",
    })
    .onConflictDoNothing()
    .returning({ id: schema.knowledgeKind.id });
  return inserted[0] ?? null;
}

/** Delete a kind. By default its entries survive (they are real documents and just
 *  lose their menu category); with withEntries=true every entry document is deleted
 *  too (chunks cascade). Bulk deletion honours the cited-QA guard unless forced. */
export async function deleteKind(
  tenant: TenantContext,
  id: string,
  opts: { withEntries?: boolean; force?: boolean } = {},
): Promise<
  | { id: string; key: string; deletedEntries: number; deletedChunks: number }
  | { blocked: true; citedQa: number }
  | null
> {
  const [kind] = await db()
    .select({ id: schema.knowledgeKind.id, key: schema.knowledgeKind.key })
    .from(schema.knowledgeKind)
    .where(
      and(
        eq(schema.knowledgeKind.id, id),
        eq(schema.knowledgeKind.hfId, tenant.hfId),
        eq(schema.knowledgeKind.companyId, tenant.companyId),
      ),
    )
    .limit(1);
  if (!kind) return null;

  let deletedEntries = 0;
  let deletedChunks = 0;
  if (opts.withEntries) {
    const res = await deleteAllEntries(tenant, kind.key, opts.force ?? false);
    if ("blocked" in res) return res;
    deletedEntries = res.deleted;
    deletedChunks = res.deletedChunks;
  }

  await db().delete(schema.knowledgeKind).where(eq(schema.knowledgeKind.id, kind.id));
  return { id: kind.id, key: kind.key, deletedEntries, deletedChunks };
}

/** Delete every entry of a kind ("delete all data"), keeping the kind itself.
 *  Refuses (blocked) when any entry is cited by a QA pair, unless forced. */
export async function deleteAllEntries(
  tenant: TenantContext,
  kindKey: string,
  force: boolean,
): Promise<{ deleted: number; deletedChunks: number; citedQa: number } | { blocked: true; citedQa: number }> {
  const docs = await db()
    .select({ id: schema.ragDocument.id })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
        sql`meta ->> 'knowledge_kind' = ${kindKey}`,
      ),
    );

  let citedQa = 0;
  for (const d of docs) citedQa += await citedQaCount(tenant, d.id);
  if (citedQa > 0 && !force) return { blocked: true, citedQa };

  let deleted = 0;
  let deletedChunks = 0;
  for (const d of docs) {
    const res = await deleteDocument(tenant, d.id);
    if (res) {
      deleted++;
      deletedChunks += res.deletedChunks;
    }
  }

  if (deleted > 0) {
    await db().insert(schema.outboxEvent).values({
      id: newId(),
      hfId: tenant.hfId,
      aggregateType: "knowledge_kind",
      aggregateId: docs[0]!.id,
      eventType: "knowledge.bulk_deleted",
      payload: { kind: kindKey, deleted, deletedChunks, citedQa },
    });
  }
  return { deleted, deletedChunks, citedQa };
}

/* ── entries ──────────────────────────────────────────────────────────────── */

async function kindByKey(tenant: TenantContext, key: string) {
  const [k] = await db()
    .select()
    .from(schema.knowledgeKind)
    .where(
      and(
        eq(schema.knowledgeKind.key, key),
        eq(schema.knowledgeKind.hfId, tenant.hfId),
        eq(schema.knowledgeKind.companyId, tenant.companyId),
      ),
    )
    .limit(1);
  return k ?? null;
}

/** body → cleaned+segmented prose block(s) → chunk rows. One entry may produce several
 *  chunks (chunkBlocks splits >400-token prose with overlap; Lao sentences intact). */
async function buildChunkRows(
  tenant: TenantContext,
  documentId: string,
  collection: string,
  title: string,
  body: string,
) {
  const seg = await segment(fixLaoDefects(body));
  const block: SegBlock = {
    kind: "prose",
    text: body,
    seg: seg.seg_text,
    tokens: seg.token_count,
    lang: seg.lang,
    headingPath: [title],
    meta: {},
  };
  const chunks = chunkBlocks([block]);
  const rows = [];
  for (const c of chunks) {
    const n = await normalize(c.content);
    rows.push({
      id: newId(),
      documentId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      branchId: null,
      collection,
      seq: c.seq,
      kind: c.kind,
      content: c.content,
      contentNorm: fixLaoDefects(n.normalized),
      contentSeg: c.contentSeg,
      headingPath: c.headingPath,
      lang: c.lang,
      tokenCount: c.tokenCount,
      embedding: null,
      // Author-is-reviewer: manual entries are accepted on creation (teach policy).
      review: "accepted" as const,
      reviewedBy: "knowledge",
      reviewedAt: new Date(),
      meta: { manual: true },
    });
  }
  return rows;
}

async function enqueueEmbed(tenant: TenantContext, documentId: string) {
  const jobId = newId();
  await db().insert(schema.ingestJob).values({
    id: jobId,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    documentId,
    kind: "embed",
    status: "queued",
    payload: { reason: "knowledge-entry" },
  });
  return jobId;
}

export async function listEntries(tenant: TenantContext, kindKey: string) {
  const docs = await db()
    .select({
      id: schema.ragDocument.id,
      title: schema.ragDocument.title,
      collection: schema.ragDocument.collection,
      createdAt: schema.ragDocument.createdAt,
      updatedAt: schema.ragDocument.updatedAt,
    })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
        sql`meta ->> 'knowledge_kind' = ${kindKey}`,
      ),
    )
    .orderBy(desc(schema.ragDocument.updatedAt));
  if (docs.length === 0) return [];

  const counts = await db()
    .select({
      documentId: schema.ragChunk.documentId,
      chunks: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) FILTER (WHERE embedding IS NULL)::int`,
      body: sql<string>`string_agg(content, E'\n' ORDER BY seq)`,
    })
    .from(schema.ragChunk)
    .where(
      and(
        eq(schema.ragChunk.hfId, tenant.hfId),
        eq(schema.ragChunk.companyId, tenant.companyId),
      ),
    )
    .groupBy(schema.ragChunk.documentId);
  const byDoc = new Map(counts.map((c) => [c.documentId, c]));

  return docs.map((d) => {
    const c = byDoc.get(d.id);
    return {
      ...d,
      chunks: c?.chunks ?? 0,
      pending: c?.pending ?? 0,
      body: c?.body ?? "",
    };
  });
}

export async function createEntry(
  tenant: TenantContext,
  input: { kindKey: string; title: string; body: string; authority?: string },
) {
  const kind = await kindByKey(tenant, input.kindKey);
  if (!kind) throw new Error(`unknown knowledge kind '${input.kindKey}'`);

  const documentId = newId();
  await db().insert(schema.ragDocument).values({
    id: documentId,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    branchId: null,
    collection: kind.collection,
    title: input.title,
    sourceFilename: "manual",
    sourceUri: `manual://${kind.key}/${documentId}`,
    lang: "lo",
    status: "chunked",
    contentSha256: sha256(new TextEncoder().encode(`${kind.key}\n${input.title}\n${input.body}`)),
    authority: input.authority ?? null,
    license: "internal",
    meta: { knowledge_kind: kind.key, manual: true },
  });

  const rows = await buildChunkRows(tenant, documentId, kind.collection, input.title, input.body);
  await db().insert(schema.ragChunk).values(rows);
  const jobId = await enqueueEmbed(tenant, documentId);

  await db().insert(schema.outboxEvent).values({
    id: newId(),
    hfId: tenant.hfId,
    aggregateType: "rag_document",
    aggregateId: documentId,
    eventType: "knowledge.created",
    payload: { kind: kind.key, title: input.title, chunks: rows.length },
  });

  return { id: documentId, chunks: rows.length, jobId };
}

/** Replace an entry's content: swap its chunks for freshly built ones and re-embed.
 *  This is the "explicit human Edit" the content-immutability rule allows. */
export async function updateEntry(
  tenant: TenantContext,
  documentId: string,
  input: { title: string; body: string },
) {
  const [doc] = await db()
    .select({
      id: schema.ragDocument.id,
      collection: schema.ragDocument.collection,
      meta: schema.ragDocument.meta,
    })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.id, documentId),
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
        sql`meta ? 'knowledge_kind'`,
      ),
    )
    .limit(1);
  if (!doc) return null;

  await db().delete(schema.ragChunk).where(eq(schema.ragChunk.documentId, documentId));
  const rows = await buildChunkRows(tenant, documentId, doc.collection, input.title, input.body);
  await db().insert(schema.ragChunk).values(rows);
  await db()
    .update(schema.ragDocument)
    .set({ title: input.title, updatedAt: new Date() })
    .where(eq(schema.ragDocument.id, documentId));
  const jobId = await enqueueEmbed(tenant, documentId);

  await db().insert(schema.outboxEvent).values({
    id: newId(),
    hfId: tenant.hfId,
    aggregateType: "rag_document",
    aggregateId: documentId,
    eventType: "knowledge.updated",
    payload: { title: input.title, chunks: rows.length },
  });

  return { id: documentId, chunks: rows.length, jobId };
}
