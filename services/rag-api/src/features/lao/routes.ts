import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { checkLao } from "./service.ts";

export const laoRoutes = new Elysia({ prefix: "/lao" }).post(
  "/check",
  async ({ body, set }) => {
    try {
      return await checkLao(devTenant(), body.text, { rewrite: body.rewrite !== false });
    } catch (err) {
      set.status = 422;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  {
    body: t.Object({
      text: t.String({ minLength: 1 }),
      // false = deterministic checkers only (LaoNLP spelling + glossary terminology),
      // no Ollama round-trip. /chat uses this for a per-answer check.
      rewrite: t.Optional(t.Boolean()),
    }),
  },
);
