import { schema } from "@arnfar/db";
import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { rerankAvailable } from "../../lib/sidecars.ts";
import { devTenant } from "../../lib/tenant.ts";
import type { Retriever } from "./retrievers.ts";
import {
  DEFAULT_EVAL_SPLITS,
  EvalPreconditionError,
  type EvalSplit,
  type QuestionForm,
  runEval,
} from "./runner.ts";

/** Always measurable. `hybrid-rrf+rerank` is appended only when the sidecar has the
 *  cross-encoder — the matrix is a comparison, and an arm that cannot run must be absent
 *  rather than present-and-failing. */
const RETRIEVERS: Retriever[] = ["dense", "lexical", "hybrid-rrf"];

/** Split buckets a caller may request. Omitting `splits` measures the tuning pool
 *  (train+dev); `test` has to be named explicitly, and the run is stamped held-out. */
const SPLIT_SCHEMA = t.Optional(
  t.Array(
    t.Union([t.Literal("train"), t.Literal("dev"), t.Literal("test"), t.Literal("unassigned")]),
    { minItems: 1 },
  ),
);

/** Form of the question to retrieve on. Defaults to `as-typed`: the seeded QA set is
 *  stored space-segmented, and no user types Lao that way. */
const QUESTION_FORM_SCHEMA = t.Optional(t.Union([t.Literal("as-typed"), t.Literal("as-stored")]));

const RETRIEVER_SCHEMA = t.Union([
  t.Literal("dense"),
  t.Literal("lexical"),
  t.Literal("hybrid-rrf"),
  t.Literal("hybrid-rrf+rerank"),
]);

/**
 * A refused run is a 422, not a 500.
 *
 * "There are no verified QA pairs" is a fact about the dataset the caller can act on, so it
 * reaches the Studio as a readable sentence with a remedy. The generic 500 handler in
 * index.ts would replace it with a correlation id, which is right for an Ollama failure and
 * useless here.
 */
function precondition(err: unknown, set: { status?: number | string }) {
  if (!(err instanceof EvalPreconditionError)) throw err;
  set.status = 422;
  return { error: "eval-precondition", message: err.message, remedy: err.remedy };
}

export const evalRoutes = new Elysia({ prefix: "/eval" })
  /** Which retriever arms this deployment can actually measure. The Studio reads it to
   *  decide whether to offer the rerank arm, so an unbuilt reranker shows as a disabled
   *  option with a reason instead of a 422 after the click. */
  .get("/capabilities", async () => {
    const rerank = await rerankAvailable();
    return {
      retrievers: rerank ? [...RETRIEVERS, "hybrid-rrf+rerank"] : RETRIEVERS,
      rerank,
      rerankHint: rerank
        ? null
        : "lao-nlp was built without the cross-encoder — rebuild with " +
          "`LAO_NLP_RERANKER=1 docker compose up -d --build lao-nlp`",
    };
  })
  .get("/runs", async () => {
    const tenant = devTenant();
    return db()
      .select()
      .from(schema.evalRun)
      .where(
        and(eq(schema.evalRun.hfId, tenant.hfId), eq(schema.evalRun.companyId, tenant.companyId)),
      )
      .orderBy(desc(schema.evalRun.createdAt))
      .limit(50);
  })
  .post(
    "/run",
    async ({ body, set }) => {
      try {
        return await runEval(devTenant(), {
          retriever: body.retriever,
          genModel: body.genModel ?? env.genModel,
          judgeModel: body.judgeModel ?? env.genModelAlt,
          collections: body.collections ?? [],
          generate: body.generate ?? false,
          adversarial: body.adversarial ?? [],
          splits: (body.splits as EvalSplit[] | undefined) ?? DEFAULT_EVAL_SPLITS,
          questionForm: (body.questionForm as QuestionForm | undefined) ?? "as-typed",
        });
      } catch (err) {
        return precondition(err, set);
      }
    },
    {
      body: t.Object({
        retriever: RETRIEVER_SCHEMA,
        genModel: t.Optional(t.String()),
        judgeModel: t.Optional(t.String()),
        collections: t.Optional(t.Array(t.String())),
        generate: t.Optional(t.Boolean()),
        adversarial: t.Optional(t.Array(t.String())),
        splits: SPLIT_SCHEMA,
        questionForm: QUESTION_FORM_SCHEMA,
      }),
    },
  )
  // Full matrix: every retriever (retrieval-only unless generate=true).
  .post(
    "/matrix",
    async ({ body, set }) => {
      const out = [];
      // Include the rerank arm only when it can run, so the matrix stays a comparison
      // rather than three results and an error.
      const arms: Retriever[] = (await rerankAvailable())
        ? [...RETRIEVERS, "hybrid-rrf+rerank"]
        : RETRIEVERS;
      try {
        for (const r of arms) {
          out.push(
            await runEval(devTenant(), {
              retriever: r,
              genModel: body.genModel ?? env.genModel,
              judgeModel: body.judgeModel ?? env.genModelAlt,
              collections: body.collections ?? [],
              generate: body.generate ?? false,
              adversarial: body.adversarial ?? [],
              splits: (body.splits as EvalSplit[] | undefined) ?? DEFAULT_EVAL_SPLITS,
              questionForm: (body.questionForm as QuestionForm | undefined) ?? "as-typed",
            }),
          );
        }
      } catch (err) {
        // The precondition is a property of the dataset, not of one arm — if it trips it
        // trips on the first retriever, before any row is written. Report it rather than
        // returning a partial matrix that looks like two arms simply failed.
        return precondition(err, set);
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
        splits: SPLIT_SCHEMA,
        questionForm: QUESTION_FORM_SCHEMA,
      }),
    },
  );
