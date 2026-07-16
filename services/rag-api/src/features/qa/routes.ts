import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import {
  assignSplits,
  createDraftFromChunk,
  createQa,
  deleteQa,
  listQa,
  qaStats,
  updateQa,
  verifyQa,
} from "./service.ts";

export const qaRoutes = new Elysia({ prefix: "/qa" })
  .get("/", async ({ query }) => {
    const filter: { verified?: boolean } = {};
    if (query.verified === "true") filter.verified = true;
    if (query.verified === "false") filter.verified = false;
    return listQa(devTenant(), filter);
  })
  .get("/stats", async () => qaStats(devTenant()))
  .post(
    "/draft",
    async ({ body, set }) => {
      try {
        return await createDraftFromChunk(devTenant(), body.chunkId);
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    { body: t.Object({ chunkId: t.String() }) },
  )
  .post(
    "/",
    async ({ body, set }) => {
      try {
        return await createQa(devTenant(), body);
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        questionLo: t.String({ minLength: 1 }),
        answerLo: t.String({ minLength: 1 }),
        questionEn: t.Optional(t.String()),
        answerEn: t.Optional(t.String()),
        citationIds: t.Array(t.String(), { minItems: 1 }),
        tags: t.Optional(t.Array(t.String())),
        difficulty: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
        source: t.Optional(t.Union([t.Literal("human"), t.Literal("chat_promoted")])),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body, set }) => {
      try {
        const res = await updateQa(devTenant(), params.id, body);
        if (!res) {
          set.status = 404;
          return { error: "qa pair not found or no fields to update" };
        }
        return { id: res.id, verified: false };
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        questionLo: t.Optional(t.String({ minLength: 1 })),
        answerLo: t.Optional(t.String({ minLength: 1 })),
        questionEn: t.Optional(t.Union([t.String(), t.Null()])),
        answerEn: t.Optional(t.Union([t.String(), t.Null()])),
        citationIds: t.Optional(t.Array(t.String(), { minItems: 1 })),
        tags: t.Optional(t.Array(t.String())),
        difficulty: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
      }),
    },
  )
  .delete("/:id", async ({ params, set }) => {
    const res = await deleteQa(devTenant(), params.id);
    if (!res) {
      set.status = 404;
      return { error: "qa pair not found" };
    }
    return { id: res.id, deleted: true };
  })
  .patch(
    "/:id/verify",
    async ({ params, body, set }) => {
      const res = await verifyQa(devTenant(), params.id, body.reviewer ?? "dev");
      if (!res) {
        set.status = 404;
        return { error: "qa pair not found" };
      }
      return { id: res.id, verified: true };
    },
    { body: t.Object({ reviewer: t.Optional(t.String()) }) },
  )
  .post("/assign-splits", async () => assignSplits(devTenant()));
