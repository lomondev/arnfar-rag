import { Elysia } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { gaps, overview } from "./service.ts";

export const dashboardRoutes = new Elysia({ prefix: "/dashboard" })
  .get("/overview", async () => overview(devTenant()))
  .get("/gaps", async () => gaps(devTenant()));
