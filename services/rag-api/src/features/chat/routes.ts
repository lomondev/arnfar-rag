import type { VerificationResponse } from "@arnfar/contracts";
import { schema } from "@arnfar/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { listGenModels } from "../../lib/ollama.ts";
import { devTenant } from "../../lib/tenant.ts";
import { createQa, verifyQa } from "../qa/service.ts";
import {
  createConversation,
  deleteConversation,
  deleteMessagesFrom,
  getConversation,
  listConversations,
  renameConversation,
} from "./conversation.ts";

import { chatStream } from "./service.ts";
import { enqueueVerification, getVerification, verifyMessage } from "./verify.ts";

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
        lang: t.Optional(
          t.Union([t.Literal("lo"), t.Literal("en"), t.Literal("th"), t.Literal("mixed")]),
        ),
        collection: t.Optional(t.String()),
      }),
    },
  )
  .get("/conversations", async () => listConversations(devTenant()))
  .get("/conversations/:id", async ({ params, set }) => {
    const conv = await getConversation(devTenant(), params.id);
    if (!conv) {
      set.status = 404;
      return { error: "not found" };
    }
    return conv;
  })
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
        lang: t.Optional(
          t.Union([t.Literal("lo"), t.Literal("en"), t.Literal("th"), t.Literal("mixed")]),
        ),
        collection: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .delete("/conversations/:id", async ({ params }) => {
    const ok = await deleteConversation(devTenant(), params.id);
    return { deleted: ok };
  })

  // ── Edit-and-resend: drop a turn and everything after it ───────────────────
  // The client then re-sends the edited question through /stream, which re-inserts the
  // user turn. Splitting it this way means the edited question takes exactly the same
  // retrieval and generation path as a fresh one — no second code path to drift.
  .delete("/messages/:id", async ({ params, set }) => {
    const result = await deleteMessagesFrom(devTenant(), params.id);
    if (!result) {
      set.status = 404;
      return { error: "message not found" };
    }
    return result;
  })

  // ── Installed generator models (for the /chat model picker) ───────────────
  // Only rag-api may touch Ollama (CLAUDE.md), so the web app fetches the model list
  // through here rather than hitting Ollama's /api/tags directly.
  .get("/models", async () => {
    const installed = await listGenModels().catch(() => [] as string[]);
    const models = installed.includes(env.genModel) ? installed : [env.genModel, ...installed];
    return { default: env.genModel, models };
  })

  /**
   * The cross-family verdict on one answer, or null while it is still queued.
   *
   * Polled by the client after `done` rather than pushed on the SSE stream: by the time a
   * verdict exists the stream has closed, and a frame that can never arrive on that stream
   * would be a lie in the contract. Holding the connection open for the ~30–60 s the CPU
   * judge takes would tie up a request to deliver one small object.
   */
  .get("/messages/:id/verification", async ({ params }): Promise<VerificationResponse> => {
    const verification = await getVerification(devTenant(), params.id);
    return { messageId: params.id, verification };
  })
  /** Force a re-check now (synchronous). Used by the Studio, and by anyone who turned
   *  CHAT_VERIFY_ANSWERS off and wants one answer checked on demand. */
  .post("/messages/:id/verify", async ({ params, set }) => {
    const verification = await verifyMessage(devTenant(), params.id);
    if (!verification) {
      set.status = 404;
      return { error: "assistant message not found" };
    }
    return { messageId: params.id, verification };
  })
  /** Queue a check without waiting for it. */
  .post("/messages/:id/verify-async", async ({ params }) => {
    await enqueueVerification(devTenant(), params.id);
    return { messageId: params.id, queued: true };
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
        ...(body.values ? { values: body.values } : {}),
        ...(body.answerLang ? { answerLang: body.answerLang } : {}),
        ...(body.teach ? { teach: body.teach } : {}),
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
        // Language for the answer. Omitted = "auto" = follow the question's script.
        answerLang: t.Optional(
          t.Union([t.Literal("auto"), t.Literal("lo"), t.Literal("en"), t.Literal("both")]),
        ),
        // Teach rather than answer — a structured explanation for a student.
        teach: t.Optional(t.Boolean()),
        // Values the user supplied for this question. amountLak is a STRING: a JSON number
        // is a double, and a large kip amount would lose precision on the wire before the
        // integer calculator ever saw it.
        values: t.Optional(
          t.Object({
            amountLak: t.Optional(t.String({ pattern: "^[0-9][0-9,\\s]*$" })),
            rateBp: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
            mode: t.Optional(t.Union([t.Literal("add"), t.Literal("extract")])),
            attributes: t.Optional(
              t.Array(t.Object({ label: t.String(), value: t.String() }), { maxItems: 12 }),
            ),
          }),
        ),
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
