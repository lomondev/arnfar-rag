import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { erpDb, erpMode } from "../../lib/erpdb.ts";
import { accountBalance, customerOutstanding, invoiceLookup, trialBalance } from "./service.ts";

const CONTRACT_VIEWS = ["arnfar_ai_customer", "arnfar_ai_invoice", "arnfar_ai_gl_entry"] as const;

/** Integration health: which backend, is it reachable, are the contract views there.
 *  This is the first thing to check after setting ERP_DATABASE_URL. */
async function erpStatus() {
  const mode = erpMode();
  const views: Record<string, boolean | number> = {};
  try {
    for (const v of CONTRACT_VIEWS) {
      try {
        const rows = (await erpDb().execute(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(v)}`,
        )) as unknown as { n: number }[];
        views[v] = rows[0]?.n ?? 0;
      } catch {
        views[v] = false;
      }
    }
    return { mode, connected: true, views };
  } catch (err) {
    return { mode, connected: false, error: String(err), views };
  }
}

/** Read-only ERP tool endpoints — for the Studio/testing. Chat invokes the same
 *  functions via deterministic intent detection (see chat/service.ts). */
export const erpRoutes = new Elysia({ prefix: "/erp" })
  .get("/status", erpStatus)
  .post(
    "/customer-outstanding",
    async ({ body }) => customerOutstanding(body.q),
    { body: t.Object({ q: t.Optional(t.String()) }) },
  )
  .post(
    "/invoice-lookup",
    async ({ body }) => invoiceLookup(body.q),
    { body: t.Object({ q: t.String({ minLength: 1 }) }) },
  )
  .post(
    "/account-balance",
    async ({ body }) => accountBalance(body.code),
    { body: t.Object({ code: t.String({ minLength: 1, maxLength: 6, pattern: "^\\d+$" }) }) },
  )
  .get("/trial-balance", async () => trialBalance());
