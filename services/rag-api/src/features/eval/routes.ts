import { schema } from "@arnfar/db";
import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { env } from "../../lib/env.ts";
import { db } from "../../lib/db.ts";
import { devTenant } from "../../lib/tenant.ts";
import { runEval } from "./runner.ts";
import type { Retriever } from "./retrievers.ts";

const RETRIEVERS: Retriever[] = ["dense", "lexical", "hybrid-rrf"];

export const evalRoutes = new Elysia({ prefix: "/eval" })
  .get("/runs", async () => {
    const tenant = devTenant();
    return db()
      .select()
      .from(schema.evalRun)
      .where(
        and(
          eq(schema.evalRun.hfId, tenant.hfId),
          eq(schema.evalRun.companyId, tenant.companyId),
        ),
      )
      .orderBy(desc(schema.evalRun.createdAt))
      .limit(50);
  })
  .post(
    "/run",
    async ({ body }) =>
      runEval(devTenant(), {
        retriever: body.retriever,
        genModel: body.genModel ?? env.genModel,
        judgeModel: body.judgeModel ?? env.genModelAlt,
        collections: body.collections ?? [],
        generate: body.generate ?? false,
        adversarial: body.adversarial ?? [],
      }),
    {
      body: t.Object({
        retriever: t.Union([t.Literal("dense"), t.Literal("lexical"), t.Literal("hybrid-rrf")]),
        genModel: t.Optional(t.String()),
        judgeModel: t.Optional(t.String()),
        collections: t.Optional(t.Array(t.String())),
        generate: t.Optional(t.Boolean()),
        adversarial: t.Optional(t.Array(t.String())),
      }),
    },
  )
  // Full matrix: every retriever (retrieval-only unless generate=true).
  .post(
    "/matrix",
    async ({ body }) => {
      const out = [];
      for (const r of RETRIEVERS) {
        out.push(
          await runEval(devTenant(), {
            retriever: r,
            genModel: body.genModel ?? env.genModel,
            judgeModel: body.judgeModel ?? env.genModelAlt,
            collections: body.collections ?? [],
            generate: body.generate ?? false,
            adversarial: body.adversarial ?? [],
          }),
        );
      }
      return out;
    },
    {
      body: t.Object({
        genModel: t.Optional(t.String()),
        judgeModel: t.Optional(t.String()),
        collections: t.Optional(t.Array(t.String())),
        generate: t.Optional(t.Boolean()),
        adversarial: t.Optional(t.Array(t.String())),
      }),
    },
  );
