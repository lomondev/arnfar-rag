import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { exportDataset } from "./export.ts";

export const exportRoutes = new Elysia({ prefix: "/export" }).post(
  "/",
  async ({ body, set }) => {
    try {
      return await exportDataset(devTenant(), body.version, {
        shareable: body.shareable ?? true,
      });
    } catch (err) {
      set.status = 422;
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  {
    body: t.Object({
      version: t.String(),
      shareable: t.Optional(t.Boolean()),
    }),
  },
);
