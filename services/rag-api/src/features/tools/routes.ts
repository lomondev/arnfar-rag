import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import {
  TOOL_DESCRIPTORS,
  coaSearch,
  docSearch,
  glossaryLookup,
  vatCalc,
} from "./service.ts";

export const toolsRoutes = new Elysia({ prefix: "/tools" })
  .get("/", () => TOOL_DESCRIPTORS)
  .post(
    "/coa-search",
    async ({ body }) => coaSearch(devTenant(), body.q, body.limit ?? 10),
    {
      body: t.Object({
        q: t.String({ minLength: 1 }),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
      }),
    },
  )
  .post(
    "/glossary-lookup",
    async ({ body }) => glossaryLookup(devTenant(), body.q, body.limit ?? 10),
    {
      body: t.Object({
        q: t.String({ minLength: 1 }),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
      }),
    },
  )
  .post(
    "/vat-calc",
    ({ body, set }) => {
      try {
        return vatCalc(body);
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        amountLak: t.Union([t.String(), t.Number()]),
        rateBp: t.Number({ minimum: 0, maximum: 10000 }),
        mode: t.Union([t.Literal("add"), t.Literal("extract")]),
      }),
    },
  )
  .post(
    "/doc-search",
    async ({ body }) =>
      docSearch(devTenant(), body.q, body.k ?? 8, body.collections),
    {
      body: t.Object({
        q: t.String({ minLength: 1 }),
        k: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
        collections: t.Optional(t.Array(t.String())),
      }),
    },
  );
