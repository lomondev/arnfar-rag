import { schema } from "@arnfar/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { listGenModels } from "../../lib/ollama.ts";
import { devTenant } from "../../lib/tenant.ts";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
} from "./conversation.ts";
import { createQa, verifyQa } from "../qa/service.ts";
import { chatStream } from "./service.ts";

export const chatRoutes = new Elysia({ prefix: "/chat" })
  // ── Conversation CRUD ──────────────────────────────────────────────────────
  .post(
    "/conversations",
    async ({ body }) => {
      const tenant = devTenant();
      return createConversation(tenant, {
        ...(body.title ? { title: body.title } : {}),
        ...(body.lang ? { lang: body.lang } : {}),
        ...(body.collection ? { collection: body.collection } : {}),
      });
    },
    {
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        lang: t.Optional(t.Union([t.Literal("lo"), t.Literal("en"), t.Literal("th"), t.Literal("mixed")])),
        collection: t.Optional(t.String()),
      }),
    },
  )
  .get("/conversations", async () => listConversations(devTenant()))
  .get(
    "/conversations/:id",
    async ({ params, set }) => {
      const conv = await getConversation(devTenant(), params.id);
      if (!conv) {
        set.status = 404;
        return { error: "not found" };
      }
      return conv;
    },
  )
  .patch(
    "/conversations/:id",
    async ({ params, body, set }) => {
      const updated = await renameConversation(devTenant(), params.id, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.lang !== undefined ? { lang: body.lang } : {}),
        ...(body.collection !== undefined ? { collection: body.collection } : {}),
      });
      if (!updated) {
        set.status = 404;
        return { error: "not found" };
      }
      return updated;
    },
    {
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        lang: t.Optional(t.Union([t.Literal("lo"), t.Literal("en"), t.Literal("th"), t.Literal("mixed")])),
        collection: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .delete(
    "/conversations/:id",
    async ({ params }) => {
      const ok = await deleteConversation(devTenant(), params.id);
      return { deleted: ok };
    },
  )

  // ── Installed generator models (for the /chat model picker) ───────────────
  // Only rag-api may touch Ollama (CLAUDE.md), so the web app fetches the model list
  // through here rather than hitting Ollama's /api/tags directly.
  .get("/models", async () => {
    const installed = await listGenModels().catch(() => [] as string[]);
    const models = installed.includes(env.genModel) ? installed : [env.genModel, ...installed];
    return { default: env.genModel, models };
  })

  // ── Multi-turn streaming chat ──────────────────────────────────────────────
  .post(
    "/stream",
    ({ body, request }) => {
      const tenant = devTenant();
      const gen = chatStream({
        message: body.message,
        tenant,
        signal: request.signal, // aborting the HTTP request cancels Ollama
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        ...(body.collections ? { collections: body.collections } : {}),
        ...(body.kinds ? { kinds: body.kinds } : {}),
        ...(body.webSearch ? { webSearch: body.webSearch } : {}),
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
        conversationId: t.Optional(t.String()),
        collections: t.Optional(t.Array(t.String())),
        kinds: t.Optional(t.Array(t.String())),
        webSearch: t.Optional(t.Boolean()),
        k: t.Optional(t.Number({ minimum: 1, maximum: 20 })),
        model: t.Optional(t.String()),
      }),
    },
  )
  // Promote a good chat answer into the dataset (source=chat_promoted, verified=false).
  // Teach mode passes verify=true: the curator IS the reviewer, so their approval marks
  // the pair verified on the spot (reviewer recorded in verified_by) — no second queue.
  .post(
    "/promote",
    async ({ body, set }) => {
      try {
        const tenant = devTenant();
        const created = await createQa(tenant, {
          questionLo: body.question,
          answerLo: body.answer,
          citationIds: body.citationIds,
          source: "chat_promoted",
          ...(body.tags ? { tags: body.tags } : {}),
        });
        if (body.verify) await verifyQa(tenant, created.id, body.reviewer ?? "teach");
        return { ...created, verified: body.verify === true };
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
        verify: t.Optional(t.Boolean()),
        reviewer: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
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
