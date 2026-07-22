import { schema } from "@arnfar/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../lib/db.ts";
import { devTenant } from "../../lib/tenant.ts";
import { ingestDocx } from "./pipeline.ts";
import { previewDocx } from "./preview.ts";
import { citedQaCount, deleteDocument, retroClean } from "./clean-corpus.ts";

async function jobStatus(id: string, hfId: string, companyId: string) {
  const [job] = await db()
    .select()
    .from(schema.ingestJob)
    .where(
      and(
        eq(schema.ingestJob.id, id),
        eq(schema.ingestJob.hfId, hfId),
        eq(schema.ingestJob.companyId, companyId),
      ),
    )
    .limit(1);
  if (!job) return null;

  const counts = job.documentId
    ? await db()
        .select({
          total: sql<number>`count(*)::int`,
          embedded: sql<number>`count(*) FILTER (WHERE embedding IS NOT NULL)::int`,
        })
        .from(schema.ragChunk)
        .where(eq(schema.ragChunk.documentId, job.documentId))
    : [{ total: 0, embedded: 0 }];

  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    documentId: job.documentId,
    total: counts[0]!.total,
    embedded: counts[0]!.embedded,
  };
}

export const ingestRoutes = new Elysia({ prefix: "/ingest" })
  // Dry-run: extract → clean report → chunk boundaries. Nothing is written; this is the
  // workbench's Clean + Chunk preview before the curator commits via POST /docx.
  .post(
    "/preview",
    async ({ body, set }) => {
      const file = body.file;
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        return await previewDocx(bytes, file.name || "upload.docx");
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    { body: t.Object({ file: t.File() }) },
  )
  // Scan (dryRun) or fix the existing corpus's Lao defects. Fixes touch content_norm +
  // content_seg only, null affected embeddings, and enqueue re-embed jobs.
  .post(
    "/retro-clean",
    async ({ body }) => retroClean(devTenant(), body.dryRun ?? true),
    { body: t.Object({ dryRun: t.Optional(t.Boolean()) }) },
  )
  // Delete a document (chunks cascade, accounts detach, storage original kept).
  // `citedQa` warns the caller how many QA pairs will lose citations — the UI surfaces
  // it in the confirm dialog before the second, forced call.
  .delete(
    "/documents/:id",
    async ({ params, query, set }) => {
      const tenant = devTenant();
      const cited = await citedQaCount(tenant, params.id);
      if (cited > 0 && query.force !== "1") {
        set.status = 409;
        return { error: `${cited} QA pair(s) cite this document's chunks`, citedQa: cited };
      }
      const res = await deleteDocument(tenant, params.id);
      if (!res) {
        set.status = 404;
        return { error: "document not found" };
      }
      return { ...res, citedQa: cited };
    },
    { query: t.Object({ force: t.Optional(t.String()) }) },
  )
  .post(
    "/docx",
    async ({ body, set }) => {
      const file = body.file;
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        return await ingestDocx({
          bytes,
          filename: file.name || "upload.docx",
          collection: body.collection,
          tenant: devTenant(),
          title: body.title,
          authority: body.authority,
          license: body.license,
        });
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        file: t.File(),
        collection: t.String(),
        title: t.Optional(t.String()),
        authority: t.Optional(t.String()),
        license: t.Optional(t.String()),
      }),
    },
  )
  .get("/jobs/:id", async ({ params, set }) => {
    const tenant = devTenant();
    const status = await jobStatus(params.id, tenant.hfId, tenant.companyId);
    if (!status) {
      set.status = 404;
      return { error: "job not found" };
    }
    return status;
  })
  // SSE: stream embed progress until the job leaves 'running'/'queued'.
  .get("/jobs/:id/stream", ({ params }) => {
    const tenant = devTenant();
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        for (let i = 0; i < 600; i++) {
          const s = await jobStatus(params.id, tenant.hfId, tenant.companyId);
          if (!s) break;
          controller.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`));
          if (s.status === "done" || s.status === "failed") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  })
  .get("/documents", async () => {
    const tenant = devTenant();
    const tenantWhere = and(
      eq(schema.ragDocument.hfId, tenant.hfId),
      eq(schema.ragDocument.companyId, tenant.companyId),
    );
    const docs = await db()
      .select({
        id: schema.ragDocument.id,
        title: schema.ragDocument.title,
        collection: schema.ragDocument.collection,
        status: schema.ragDocument.status,
        lang: schema.ragDocument.lang,
        createdAt: schema.ragDocument.createdAt,
      })
      .from(schema.ragDocument)
      .where(tenantWhere)
      .orderBy(desc(schema.ragDocument.createdAt));

    // Chunk counts grouped separately, then merged (a correlated subquery over the
    // outer table misfired under drizzle's sql template — this is reliable).
    const counts = await db()
      .select({
        documentId: schema.ragChunk.documentId,
        chunks: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) FILTER (WHERE embedding IS NULL)::int`,
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

    return docs.map((d) => ({
      ...d,
      chunks: byDoc.get(d.id)?.chunks ?? 0,
      pending: byDoc.get(d.id)?.pending ?? 0,
    }));
  })
  // Corpus-wide stats for the GATE 3 report.
  .get("/stats", async () => {
    const tenant = devTenant();
    const where = and(
      eq(schema.ragChunk.hfId, tenant.hfId),
      eq(schema.ragChunk.companyId, tenant.companyId),
    );
    const byKind = await db()
      .select({ kind: schema.ragChunk.kind, n: sql<number>`count(*)::int` })
      .from(schema.ragChunk)
      .where(where)
      .groupBy(schema.ragChunk.kind);
    const byLang = await db()
      .select({ lang: schema.ragChunk.lang, n: sql<number>`count(*)::int` })
      .from(schema.ragChunk)
      .where(where)
      .groupBy(schema.ragChunk.lang);
    const [tok] = await db()
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) FILTER (WHERE embedding IS NULL)::int`,
        minTok: sql<number>`coalesce(min(token_count),0)::int`,
        maxTok: sql<number>`coalesce(max(token_count),0)::int`,
        avgTok: sql<number>`coalesce(round(avg(token_count)),0)::int`,
      })
      .from(schema.ragChunk)
      .where(where);
    return { byKind, byLang, ...tok };
  });
