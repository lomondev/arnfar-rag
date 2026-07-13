import { schema } from "@arnfar/db";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { normalize, segment } from "../../lib/sidecars.ts";
import { devTenant } from "../../lib/tenant.ts";

/** Studio review API — the human-in-the-loop surface. Edits re-segment, re-normalize,
 *  and re-queue the chunk for embedding; rejects exclude it from retrieval + exports. */
export const reviewRoutes = new Elysia({ prefix: "/review" })
  .get("/documents/:id/chunks", async ({ params }) => {
    const tenant = devTenant();
    return db()
      .select({
        id: schema.ragChunk.id,
        seq: schema.ragChunk.seq,
        kind: schema.ragChunk.kind,
        content: schema.ragChunk.content,
        contentNorm: schema.ragChunk.contentNorm,
        contentSeg: schema.ragChunk.contentSeg,
        headingPath: schema.ragChunk.headingPath,
        tokenCount: schema.ragChunk.tokenCount,
        lang: schema.ragChunk.lang,
        review: schema.ragChunk.review,
        embedded: sql<boolean>`(embedding IS NOT NULL)`,
        meta: schema.ragChunk.meta,
      })
      .from(schema.ragChunk)
      .where(
        and(
          eq(schema.ragChunk.documentId, params.id),
          eq(schema.ragChunk.hfId, tenant.hfId),
          eq(schema.ragChunk.companyId, tenant.companyId),
        ),
      )
      .orderBy(asc(schema.ragChunk.seq));
  })
  .patch(
    "/chunks/:id",
    async ({ params, body, set }) => {
      const tenant = devTenant();
      const [chunk] = await db()
        .select()
        .from(schema.ragChunk)
        .where(
          and(
            eq(schema.ragChunk.id, params.id),
            eq(schema.ragChunk.hfId, tenant.hfId),
            eq(schema.ragChunk.companyId, tenant.companyId),
          ),
        )
        .limit(1);
      if (!chunk) {
        set.status = 404;
        return { error: "chunk not found" };
      }

      const now = new Date();
      if (body.action === "accept") {
        await db()
          .update(schema.ragChunk)
          .set({ review: "accepted", reviewedBy: body.reviewer ?? "dev", reviewedAt: now })
          .where(eq(schema.ragChunk.id, params.id));
        return { id: params.id, review: "accepted" };
      }
      if (body.action === "reject") {
        await db()
          .update(schema.ragChunk)
          .set({ review: "rejected", reviewedBy: body.reviewer ?? "dev", reviewedAt: now })
          .where(eq(schema.ragChunk.id, params.id));
        return { id: params.id, review: "rejected" };
      }
      // edit: rewrite content → re-segment + re-normalize → re-embed this chunk only.
      const content = body.content ?? "";
      if (!content.trim()) {
        set.status = 422;
        return { error: "edit requires non-empty content" };
      }
      const [seg, norm] = await Promise.all([segment(content), normalize(content)]);
      await db()
        .update(schema.ragChunk)
        .set({
          content,
          contentSeg: seg.seg_text,
          contentNorm: norm.normalized,
          tokenCount: seg.token_count,
          lang: seg.lang,
          review: "edited",
          reviewedBy: body.reviewer ?? "dev",
          reviewedAt: now,
          embedding: null, // force re-embed
        })
        .where(eq(schema.ragChunk.id, params.id));
      // Re-queue embedding for the document.
      await db().insert(schema.ingestJob).values({
        id: newId(),
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        documentId: chunk.documentId,
        kind: "embed",
        status: "queued",
        payload: { reason: "edit" },
      });
      return { id: params.id, review: "edited", reembedQueued: true };
    },
    {
      body: t.Object({
        action: t.Union([t.Literal("accept"), t.Literal("reject"), t.Literal("edit")]),
        content: t.Optional(t.String()),
        reviewer: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/bulk-accept",
    async ({ body }) => {
      const tenant = devTenant();
      const conds = [
        eq(schema.ragChunk.documentId, body.documentId),
        eq(schema.ragChunk.hfId, tenant.hfId),
        eq(schema.ragChunk.companyId, tenant.companyId),
        eq(schema.ragChunk.review, "pending"),
      ];
      if (body.kind) conds.push(eq(schema.ragChunk.kind, body.kind));
      if (body.minTokens) conds.push(gt(schema.ragChunk.tokenCount, body.minTokens));
      const updated = await db()
        .update(schema.ragChunk)
        .set({ review: "accepted", reviewedBy: body.reviewer ?? "dev", reviewedAt: new Date() })
        .where(and(...conds))
        .returning({ id: schema.ragChunk.id });
      return { accepted: updated.length };
    },
    {
      body: t.Object({
        documentId: t.String(),
        kind: t.Optional(
          t.Union([
            t.Literal("prose"),
            t.Literal("table"),
            t.Literal("account_row"),
            t.Literal("list"),
          ]),
        ),
        minTokens: t.Optional(t.Number()),
        reviewer: t.Optional(t.String()),
      }),
    },
  );
