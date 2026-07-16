import { Elysia, t } from "elysia";

import { listDomains } from "../../domains/registry.ts";
import { listRoles } from "../../domains/roles.ts";
import { devTenant } from "../../lib/tenant.ts";
import { AgentError, askAgent } from "./service.ts";

export const agentRoutes = new Elysia({ prefix: "/agent" })
  .get("/domains", () => listDomains())
  .get("/roles", () => listRoles())
  .post(
    "/ask",
    async ({ body, set }) => {
      try {
        return await askAgent({ ...body, tenant: devTenant() });
      } catch (err) {
        if (err instanceof AgentError) {
          set.status = err.status;
          return { error: err.message };
        }
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        question: t.String({ minLength: 1 }),
        domain: t.Optional(t.String()),
        role: t.Optional(t.String()),
        k: t.Optional(t.Number({ minimum: 1, maximum: 20 })),
        model: t.Optional(t.String()),
      }),
    },
  );
