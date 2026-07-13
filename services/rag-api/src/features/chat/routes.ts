import { schema } from "@arnfar/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../lib/db.ts";
import { devTenant } from "../../lib/tenant.ts";
import { createQa } from "../qa/service.ts";
import { chatStream } from "./service.ts";

export const chatRoutes = new Elysia({ prefix: "/chat" })
  .post(
    "/stream",
    ({ body, request }) => {
      const tenant = devTenant();
      const gen = chatStream({
        message: body.message,
        tenant,
        signal: request.signal, // aborting the HTTP request cancels Ollama
        ...(body.collections ? { collections: body.collections } : {}),
        ...(body.k ? { k: body.k } : {}),
        ...(body.model ? { model: body.model } : {}),
      });
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          try {
            for await (const ev of gen) {
              controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
            }
          } catch (e) {
            controller.enqueue(
              enc.encode(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`),
            );
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },
    {
      body: t.Object({
        message: t.String({ minLength: 1 }),
        collections: t.Optional(t.Array(t.String())),
        k: t.Optional(t.Number({ minimum: 1, maximum: 20 })),
        model: t.Optional(t.String()),
      }),
    },
  )
  // Promote a good chat answer into the dataset (source=chat_promoted, verified=false).
  .post(
    "/promote",
    async ({ body, set }) => {
      try {
        return await createQa(devTenant(), {
          questionLo: body.question,
          answerLo: body.answer,
          citationIds: body.citationIds,
          source: "chat_promoted",
          ...(body.tags ? { tags: body.tags } : {}),
        });
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        question: t.String({ minLength: 1 }),
        answer: t.String({ minLength: 1 }),
        citationIds: t.Array(t.String(), { minItems: 1 }),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  // Report wrong: flag the cited chunks for re-review (closes the loop to /studio/review).
  .post(
    "/report-wrong",
    async ({ body }) => {
      const tenant = devTenant();
      const updated = await db()
        .update(schema.ragChunk)
        .set({ meta: sql`${schema.ragChunk.meta} || '{"reported":true}'::jsonb` })
        .where(
          and(
            inArray(schema.ragChunk.id, body.chunkIds),
            eq(schema.ragChunk.hfId, tenant.hfId),
            eq(schema.ragChunk.companyId, tenant.companyId),
          ),
        )
        .returning({ id: schema.ragChunk.id });
      return { flagged: updated.length };
    },
    { body: t.Object({ chunkIds: t.Array(t.String(), { minItems: 1 }) }) },
  );
