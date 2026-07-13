import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { checkLao } from "./service.ts";

export const laoRoutes = new Elysia({ prefix: "/lao" }).post(
  "/check",
  async ({ body, set }) => {
    try {
      return await checkLao(devTenant(), body.text);
    } catch (err) {
      set.status = 422;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  { body: t.Object({ text: t.String({ minLength: 1 }) }) },
);
