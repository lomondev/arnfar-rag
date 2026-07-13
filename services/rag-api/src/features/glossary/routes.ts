import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { listTerms, mineAndDraft, updateTerm, verifyTerm } from "./service.ts";

export const glossaryRoutes = new Elysia({ prefix: "/glossary" })
  .get("/", async ({ query }) => {
    const verified =
      query.verified === "true" ? true : query.verified === "false" ? false : undefined;
    return listTerms(devTenant(), verified);
  })
  .post(
    "/mine",
    async ({ body }) =>
      mineAndDraft(devTenant(), {
        minFreq: body.minFreq ?? 2,
        limit: body.limit ?? 50,
        gloss: body.gloss ?? false,
      }),
    {
      body: t.Object({
        minFreq: t.Optional(t.Number({ minimum: 1 })),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })),
        gloss: t.Optional(t.Boolean()),
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body, set }) => {
      const res = await updateTerm(devTenant(), params.id, body);
      if (!res) {
        set.status = 404;
        return { error: "term not found or no fields to update" };
      }
      return { id: res.id };
    },
    {
      body: t.Object({
        termEn: t.Optional(t.String()),
        definitionLo: t.Optional(t.String()),
        definitionEn: t.Optional(t.String()),
        variantsLo: t.Optional(t.Array(t.String())),
        forbiddenLo: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .patch(
    "/:id/verify",
    async ({ params, body, set }) => {
      const res = await verifyTerm(devTenant(), params.id, body.reviewer ?? "dev");
      if (!res) {
        set.status = 404;
        return { error: "term not found" };
      }
      return { id: res.id, verified: true };
    },
    { body: t.Object({ reviewer: t.Optional(t.String()) }) },
  );
