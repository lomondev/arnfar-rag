import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { search } from "./service.ts";

export const searchRoutes = new Elysia({ prefix: "/search" }).post(
  "/",
  async ({ body, query }) => {
    return search({
      query: body.query,
      collections: body.collections,
      k: body.k,
      tenant: devTenant(),
      explain: query.explain === "1",
    });
  },
  {
    body: t.Object({
      query: t.String({ minLength: 1 }),
      collections: t.Optional(t.Array(t.String())),
      k: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
    }),
    query: t.Object({ explain: t.Optional(t.String()) }),
  },
);
