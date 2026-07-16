import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
  verifyAccount,
} from "./service.ts";

const accountClass = t.Union([
  t.Literal("asset"),
  t.Literal("liability"),
  t.Literal("equity"),
  t.Literal("revenue"),
  t.Literal("expense"),
]);
const normalBalance = t.Union([t.Literal("debit"), t.Literal("credit")]);
const statement = t.Union([
  t.Literal("BS"),
  t.Literal("PL"),
  t.Literal("CF"),
  t.Literal("NONE"),
]);

export const accountsRoutes = new Elysia({ prefix: "/accounts" })
  .get("/", async ({ query }) => {
    const verified =
      query.verified === "true" ? true : query.verified === "false" ? false : undefined;
    return listAccounts(devTenant(), verified);
  })
  .post(
    "/",
    async ({ body, set }) => {
      const res = await createAccount(devTenant(), body);
      if (!res) {
        set.status = 409;
        return { error: `account code ${body.code} already exists` };
      }
      set.status = 201;
      return { id: res.id };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 1 }),
        nameLo: t.String({ minLength: 1 }),
        nameEn: t.Optional(t.String()),
        parentCode: t.Optional(t.String()),
        accountClass,
        normalBalance,
        statement,
      }),
    },
  )
  .patch(
    "/:id",
    async ({ params, body, set }) => {
      const res = await updateAccount(devTenant(), params.id, body);
      if (!res) {
        set.status = 404;
        return { error: "account not found or no fields to update" };
      }
      return { id: res.id, verified: false };
    },
    {
      body: t.Object({
        code: t.Optional(t.String({ minLength: 1 })),
        nameLo: t.Optional(t.String({ minLength: 1 })),
        nameEn: t.Optional(t.String()),
        parentCode: t.Optional(t.String()),
        accountClass: t.Optional(accountClass),
        normalBalance: t.Optional(normalBalance),
        statement: t.Optional(statement),
      }),
    },
  )
  .patch("/:id/verify", async ({ params, set }) => {
    const res = await verifyAccount(devTenant(), params.id);
    if (!res) {
      set.status = 404;
      return { error: "account not found" };
    }
    return { id: res.id, verified: true };
  })
  .delete("/:id", async ({ params, set }) => {
    const res = await deleteAccount(devTenant(), params.id);
    if (!res) {
      set.status = 404;
      return { error: "account not found" };
    }
    return { id: res.id, deleted: true };
  });
