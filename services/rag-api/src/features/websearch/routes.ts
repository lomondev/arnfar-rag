import { Elysia, t } from "elysia";

import { webSearch } from "./service.ts";

/** Standalone endpoint so the workbench (and curl) can exercise web search without
 *  running a full chat generation. Chat integrates via chatStream's webSearch flag. */
export const websearchRoutes = new Elysia({ prefix: "/websearch" }).post(
  "/",
  async ({ body }) => {
    const results = await webSearch(body.query, body.k ?? 3);
    return { query: body.query, results };
  },
  {
    body: t.Object({
      query: t.String({ minLength: 1 }),
      k: t.Optional(t.Number({ minimum: 1, maximum: 8 })),
    }),
  },
);
