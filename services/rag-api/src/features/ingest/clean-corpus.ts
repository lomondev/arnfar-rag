import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { segment } from "../../lib/sidecars.ts";
import type { Tenant } from "./pipeline.ts";
import { fixLaoDefects, scanLaoDefects } from "../lao/clean.ts";

/** Retro-clean the EXISTING corpus: chunks ingested before the clean stage existed carry
 *  defects (doubled vowels, broken syllables, zero-width junk) in their derived columns.
 *
 *  Fixes land ONLY in content_norm (re-fixed) and content_seg (re-segmented from cleaned
 *  content) — `content` stays byte-for-byte (CLAUDE.md). Fixed rows get embedding=NULL,
 *  and one embed job per affected document is enqueued; the resumable worker re-embeds
 *  exactly the nulled rows (WHERE embedding IS NULL). */

export interface RetroCleanReport {
  scanned: number;
  affected: number;
  byDefect: { zeroWidth: number; doubledMarks: number; spaceBeforeMark: number };
  byDocument: { documentId: string; affected: number }[];
  /** Only set when dryRun=false: */
  fixed?: number;
  reembedJobs?: string[];
}

export async function retroClean(tenant: Tenant, dryRun: boolean): Promise<RetroCleanReport> {
  const rows = await db()
    .select({
      id: schema.ragChunk.id,
      documentId: schema.ragChunk.documentId,
      content: schema.ragChunk.content,
      contentNorm: schema.ragChunk.contentNorm,
    })
    .from(schema.ragChunk)
    .where(
      and(
        eq(schema.ragChunk.hfId, tenant.hfId),
        eq(schema.ragChunk.companyId, tenant.companyId),
      ),
    );

  const byDefect = { zeroWidth: 0, doubledMarks: 0, spaceBeforeMark: 0 };
  const perDoc = new Map<string, number>();
  const affected: typeof rows = [];

  for (const r of rows) {
    // Scan content_norm — the column retrieval actually embeds. Raw `content` keeps its
    // defects forever by design (byte-for-byte), so scanning it would report "affected"
    // even after a fix; norm goes clean once fixed, making the scan a true status check.
    const d = scanLaoDefects(r.contentNorm);
    if (d.total === 0) continue;
    byDefect.zeroWidth += d.zeroWidth;
    byDefect.doubledMarks += d.doubledMarks;
    byDefect.spaceBeforeMark += d.spaceBeforeMark;
    if (r.documentId) perDoc.set(r.documentId, (perDoc.get(r.documentId) ?? 0) + 1);
    affected.push(r);
  }

  const report: RetroCleanReport = {
    scanned: rows.length,
    affected: affected.length,
    byDefect,
    byDocument: [...perDoc.entries()].map(([documentId, n]) => ({ documentId, affected: n })),
  };
  if (dryRun || affected.length === 0) return report;

  // Fix norm + re-segment seg from cleaned content, null the embedding (concurrency is
  // modest: one segment() call per defective chunk, sequential — the sidecar is local).
  let fixed = 0;
  for (const r of affected) {
    const cleanedContent = fixLaoDefects(r.content);
    const seg = await segment(cleanedContent);
    await db()
      .update(schema.ragChunk)
      .set({
        contentNorm: fixLaoDefects(r.contentNorm),
        contentSeg: seg.seg_text,
        embedding: null,
      })
      .where(eq(schema.ragChunk.id, r.id));
    fixed++;
  }

  // One embed job per affected document; the worker refills WHERE embedding IS NULL.
  const reembedJobs: string[] = [];
  for (const documentId of perDoc.keys()) {
    const jobId = newId();
    await db().insert(schema.ingestJob).values({
      id: jobId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      documentId,
      kind: "embed",
      status: "queued",
      payload: { reason: "retro-clean" },
    });
    reembedJobs.push(jobId);
  }

  await db().insert(schema.outboxEvent).values({
    id: newId(),
    hfId: tenant.hfId,
    aggregateType: "rag_chunk",
    aggregateId: affected[0]!.id,
    eventType: "corpus.retro_cleaned",
    payload: { affected: affected.length, byDefect },
  });

  return { ...report, fixed, reembedJobs };
}

/** Delete a document: chunks cascade, accounts detach (FK set null), original file in
 *  storage is KEPT as the archive of record. Emits an audit event. */
export async function deleteDocument(
  tenant: Tenant,
  documentId: string,
): Promise<{ id: string; deletedChunks: number } | null> {
  const [doc] = await db()
    .select({ id: schema.ragDocument.id, title: schema.ragDocument.title })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.id, documentId),
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
      ),
    )
    .limit(1);
  if (!doc) return null;

  const chunkIds = await db()
    .select({ id: schema.ragChunk.id })
    .from(schema.ragChunk)
    .where(eq(schema.ragChunk.documentId, documentId));

  // Clean up this document's queued jobs first (FK has no cascade from job → doc).
  await db().delete(schema.ingestJob).where(eq(schema.ingestJob.documentId, documentId));
  await db().delete(schema.ragDocument).where(eq(schema.ragDocument.id, documentId));

  await db().insert(schema.outboxEvent).values({
    id: newId(),
    hfId: tenant.hfId,
    aggregateType: "rag_document",
    aggregateId: documentId,
    eventType: "document.deleted",
    payload: { title: doc.title, deletedChunks: chunkIds.length },
  });

  return { id: documentId, deletedChunks: chunkIds.length };
}

/** Guard against deleting a document whose chunks are cited by QA pairs — the pairs
 *  would silently become unexportable. Returns the number of QA pairs affected. */
export async function citedQaCount(tenant: Tenant, documentId: string): Promise<number> {
  const chunkIds = (
    await db()
      .select({ id: schema.ragChunk.id })
      .from(schema.ragChunk)
      .where(eq(schema.ragChunk.documentId, documentId))
  ).map((r) => r.id);
  if (chunkIds.length === 0) return 0;

  const qa = await db()
    .select({ id: schema.laoQaPair.id, citationIds: schema.laoQaPair.citationIds })
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
      ),
    );
  const cited = new Set(chunkIds);
  return qa.filter((q) => q.citationIds.some((c) => cited.has(c))).length;
}
