import { Elysia, t } from "elysia";

import { accountBalance, customerOutstanding, invoiceLookup, trialBalance } from "./service.ts";

/** Read-only ERP tool endpoints — for the Studio/testing. Chat invokes the same
 *  functions via deterministic intent detection (see chat/service.ts). */
export const erpRoutes = new Elysia({ prefix: "/erp" })
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
