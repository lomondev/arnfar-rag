import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { newId } from "../../lib/ids.ts";
import { rerankAvailable } from "../../lib/sidecars.ts";
import { joinLaoWordSpaces, looksSegmented } from "../lao/clean.ts";
import { prepareQuery } from "../search/service.ts";
import { ragAnswer } from "./generate.ts";
import { judgeFaithfulness } from "./judge.ts";
import {
  GATE_MIN_QUERIES,
  hitRank,
  hitRateAtK,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  sampleVerdict,
} from "./metrics.ts";
import { type Retriever, retrieve } from "./retrievers.ts";

/**
 * Refusal to produce a number that would not mean anything.
 *
 * Thrown before any `eval_run` row exists, so a run that cannot be measured leaves no
 * record claiming it was. The route maps this to 422 with the message intact.
 */
export class EvalPreconditionError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "EvalPreconditionError";
    this.remedy = remedy;
  }
}

/** Which `lao_qa_pair.split` buckets a run measures.
 *
 *  This exists because the harness used to measure ALL verified pairs. The `split` column
 *  was populated and nothing read it, so every run scored 71% training data AND consumed
 *  `test` — the held-out set CLAUDE.md says is "never used for tuning". A gate number
 *  measured that way is not a gate number.
 *
 *  `unassigned` is selectable so a fresh corpus (nothing bucketed yet) can still be
 *  measured deliberately rather than silently.
 */
export type EvalSplit = "train" | "dev" | "test" | "unassigned";

/** Routine runs measure the tuning pool. `test` is excluded unless a caller asks for it
 *  by name — see `isHeldOut` below. */
export const DEFAULT_EVAL_SPLITS: EvalSplit[] = ["train", "dev"];

/** True when a run touches the held-out set. Such runs are stamped into `eval_run.params`
 *  and `notes`, so the ledger always shows which numbers came from `test` and a later
 *  reader can discount anything that was tuned against it. */
export function isHeldOut(splits: EvalSplit[]): boolean {
  return splits.includes("test");
}

/**
 * Which form of the question the run retrieves on.
 *
 * `as-stored` uses `question_lo` verbatim. The seeded QA set was authored space-segmented
 * (`ຄິດໄລ່ ອາກອນມູນຄ່າເພີ່ມ ຕ້ອງ ຊຳລະ ສຸດທິ ແນວ ໃດ`), and real Lao is written without spaces
 * between words — so a run in that form hands the lexical arm a query whose word
 * boundaries already agree with the corpus's own hand-authored ones. That is a free ride
 * no real query gets, and it inflates recall.
 *
 * `as-typed` joins those word-boundary spaces first (`joinLaoWordSpaces`, which protects
 * initialisms like ສປປ ລາວ), so LaoNLP performs the segmentation on the natural form —
 * exactly what happens to a question a person types into /chat.
 *
 * Both are kept because the DIFFERENCE is the measurement that matters: it is the size of
 * the train/serve skew, and you cannot report it from one number.
 */
export type QuestionForm = "as-stored" | "as-typed";

export interface EvalConfig {
  retriever: Retriever;
  genModel: string;
  judgeModel: string;
  collections: string[];
  generate: boolean; // run generation + faithfulness (slow)
  adversarial: string[]; // Lao questions whose answer is NOT in the corpus
  /** Split buckets to measure. Defaults to the tuning pool, never the held-out set. */
  splits: EvalSplit[];
  /** Form of the question to retrieve on. Defaults to `as-typed` — what a user produces. */
  questionForm: QuestionForm;
}

// Collections are user-creatable; an empty list now means "whole tenant corpus"
// down in the retrievers rather than a fixed allowlist.
const TOP_K = 10;
const CONTEXT_K = 5;

async function chunkContents(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db()
    .select({ id: schema.ragChunk.id, content: schema.ragChunk.content })
    .from(schema.ragChunk)
    .where(inArray(schema.ragChunk.id, ids));
  return new Map(rows.map((r) => [r.id, r.content]));
}

/**
 * The gold set for a run: verified QA pairs whose split is one the caller asked for.
 *
 * Extracted from `runEval` so the split predicate — the thing that decides whether a
 * number is a tuning number or a gate number — is directly testable. The predicate is
 * the whole point: without it a run mixes the tuning pool with the held-out set and
 * reports one figure for both.
 */
export async function selectEvalPairs(tenant: TenantContext, splits: EvalSplit[]) {
  return db()
    .select()
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
        eq(schema.laoQaPair.verified, true),
        inArray(schema.laoQaPair.split, splits),
      ),
    );
}

/** The question as the retriever should see it, per the run's `questionForm`.
 *  `joinLaoWordSpaces` is a no-op on a question that was already written naturally, so
 *  `as-typed` is safe to apply unconditionally. Nothing is written back — the stored
 *  `question_lo` is human-authored text and this is a read-time transform. */
function questionFor(form: QuestionForm, questionLo: string): string {
  return form === "as-typed" ? joinLaoWordSpaces(questionLo) : questionLo;
}

export async function runEval(tenant: TenantContext, cfg: EvalConfig) {
  const collections = cfg.collections;

  // Eval set = verified QA pairs in the requested splits; gold = their citations.
  const splits = cfg.splits.length ? cfg.splits : DEFAULT_EVAL_SPLITS;
  const pairs = await selectEvalPairs(tenant, splits);

  // Refuse before any row exists. A run over zero gold queries used to write
  // recall=0.0000 / faithfulness=0.0000 / p95=0ms into the ledger — numbers that read as a
  // broken retriever and are in fact a measurement that never happened. Three such rows are
  // already on record in this database.
  const sample = sampleVerdict(pairs.length);
  if (!sample.usable) {
    throw new EvalPreconditionError(
      `cannot evaluate on split ${splits.join("+")}: ${sample.note}`,
      "verify QA pairs in /studio/teach or /studio/qa — the eval set is `lao_qa_pair` " +
        "WHERE verified = true AND split IN (" +
        splits.join(", ") +
        "), and an unverified draft is not gold. If the splits are empty, assign them " +
        "first (they bucket by source document, never by row).",
    );
  }

  // Refuse the rerank arm on the small lao-nlp image, before any row exists. The
  // alternative — discovering it 30 queries in — leaves a half-populated eval_run whose
  // retriever column names a pipeline that never ran.
  if (cfg.retriever === "hybrid-rrf+rerank" && !(await rerankAvailable())) {
    throw new EvalPreconditionError(
      "cannot evaluate: lao-nlp has no cross-encoder, so `hybrid-rrf+rerank` cannot run",
      "rebuild the sidecar with the reranker: `LAO_NLP_RERANKER=1 docker compose up -d " +
        "--build lao-nlp` (~2.5GB, bge-reranker-v2-m3), then re-run.",
    );
  }

  // Census of the gold set's own storage format, recorded on the run. Computed before any
  // retrieval so it describes the dataset, not the run's behaviour.
  const segmentedCount = pairs.filter((p) => looksSegmented(p.questionLo)).length;

  const runId = newId();
  await db()
    .insert(schema.evalRun)
    .values({
      id: runId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      // The model that actually produced the vectors this run searched — not a
      // literal. OLLAMA_EMBED_MODEL is configurable, and an eval ledger that
      // names the wrong model makes every historical comparison unreadable.
      embedModel: env.embedModel,
      genModel: cfg.genModel,
      retriever: cfg.retriever,
      params: {
        collections,
        top_k: TOP_K,
        judge_model: cfg.judgeModel,
        generate: cfg.generate,
        splits,
        held_out: isHeldOut(splits),
        question_form: cfg.questionForm,
        // How many gold questions were stored space-segmented. A high count next to a
        // high recall is the tell that the number owes something to the storage format
        // rather than to the retriever.
        segmented_questions: segmentedCount,
      },
      // A run that touched `test` says so in the ledger itself. Historical rows carry no
      // splits key at all, which is exactly how a reader spots the runs from before this
      // filter existed — those measured everything, including the held-out set.
      ...(isHeldOut(splits)
        ? { notes: `HELD-OUT: measured ${splits.join("+")} — do not tune against this run` }
        : {}),
      nQueries: pairs.length,
    });

  const r5: number[] = [];
  const r10: number[] = [];
  const p5: number[] = [];
  const n10: number[] = [];
  const hr5: number[] = [];
  const rr: number[] = [];
  const latencies: number[] = [];
  const faith: number[] = [];

  for (const p of pairs) {
    // Same preparation production uses (segment + embed + glossary expansion), so the
    // measured retriever sees the string a user's question would produce. Kept outside
    // the timer: p95 is the DB retrieval budget, not sidecar round-trips.
    const askedAs = questionFor(cfg.questionForm, p.questionLo);
    const prepared = await prepareQuery(askedAs, tenant);
    const t0 = performance.now();
    const retrieved = await retrieve(cfg.retriever, {
      tenant,
      collections,
      queryEmbedding: prepared.queryEmbedding,
      querySeg: prepared.querySeg,
      queryText: askedAs,
      k: TOP_K,
    });
    const latency = Math.round(performance.now() - t0);
    latencies.push(latency);

    const gold = p.citationIds;
    r5.push(recallAtK(retrieved, gold, 5));
    r10.push(recallAtK(retrieved, gold, 10));
    // CONTEXT_K is the generator's window, so precision and hit rate are measured at the
    // same depth the answer is actually built from — a precision@5 that is not the top-5
    // the model reads describes a pipeline nobody runs.
    p5.push(precisionAtK(retrieved, gold, CONTEXT_K));
    hr5.push(hitRateAtK(retrieved, gold, CONTEXT_K));
    n10.push(ndcgAtK(retrieved, gold, TOP_K));
    rr.push(reciprocalRank(retrieved, gold));
    const rank = hitRank(retrieved, gold);

    let answer: string | null = null;
    let judgeScore: number | null = null;
    let judgeReason: string | null = null;
    if (cfg.generate) {
      const contents = await chunkContents(retrieved.slice(0, CONTEXT_K));
      const contexts = retrieved.slice(0, CONTEXT_K).map((id) => contents.get(id) ?? "");
      answer = await ragAnswer(p.questionLo, contexts, cfg.genModel);
      const j = await judgeFaithfulness(p.questionLo, answer, contexts, cfg.judgeModel);
      judgeScore = j.score;
      judgeReason = j.reason;
      faith.push(j.score / 5);
    }

    await db().insert(schema.evalResult).values({
      id: newId(),
      runId,
      qaPairId: p.id,
      retrievedIds: retrieved,
      hitRank: rank,
      answerLo: answer,
      judgeScore,
      judgeReason,
      latencyMs: latency,
    });
  }

  // Adversarial abstention (not persisted to eval_result — no qa_pair).
  let abstentionRate: number | null = null;
  if (cfg.generate && cfg.adversarial.length) {
    let abstained = 0;
    for (const q of cfg.adversarial) {
      const prepared = await prepareQuery(q, tenant);
      const retrieved = await retrieve(cfg.retriever, {
        tenant,
        collections,
        queryEmbedding: prepared.queryEmbedding,
        querySeg: prepared.querySeg,
        queryText: q,
        k: CONTEXT_K,
      });
      const contents = await chunkContents(retrieved);
      const contexts = retrieved.map((id) => contents.get(id) ?? "");
      const answer = await ragAnswer(q, contexts, cfg.genModel);
      const j = await judgeFaithfulness(q, answer, contexts, cfg.judgeModel);
      if (j.abstained) abstained++;
    }
    abstentionRate = abstained / cfg.adversarial.length;
  }

  const recall5 = mean(r5);
  const recall10 = mean(r10);
  const precision5 = mean(p5);
  const ndcg10 = mean(n10);
  const hitRate5 = mean(hr5);
  const mrr = mean(rr);
  const faithfulness = cfg.generate ? mean(faith) : null;
  const p95 = percentile(latencies, 95);

  // `numeric` columns stay NULL when there was nothing to average. The UI already renders
  // NULL as "—"; it had no way to render "measured, and the answer is zero" differently
  // from "never measured" while both arrived as 0.0000.
  const fixed = (v: number | null): string | null => (v === null ? null : v.toFixed(4));

  const notes = [
    sample.note,
    abstentionRate === null ? null : `abstention_on_adversarial=${abstentionRate.toFixed(2)}`,
  ]
    .filter((n): n is string => n !== null)
    .join("; ");

  await db()
    .update(schema.evalRun)
    .set({
      recallAt5: fixed(recall5),
      recallAt10: fixed(recall10),
      precisionAt5: fixed(precision5),
      ndcgAt10: fixed(ndcg10),
      hitRateAt5: fixed(hitRate5),
      mrr: fixed(mrr),
      faithfulness: fixed(faithfulness),
      p95LatencyMs: p95 === null ? null : Math.round(p95),
      notes: notes === "" ? null : notes,
    })
    .where(eq(schema.evalRun.id, runId));

  return {
    runId,
    retriever: cfg.retriever,
    genModel: cfg.genModel,
    nQueries: pairs.length,
    // False when the sample is too small to settle GATE 6 either way. The caller should not
    // have to re-derive that from nQueries and a threshold it does not own.
    gateEvidence: sample.gateEvidence,
    minQueriesForGate: GATE_MIN_QUERIES,
    recallAt5: recall5,
    recallAt10: recall10,
    precisionAt5: precision5,
    ndcgAt10: ndcg10,
    hitRateAt5: hitRate5,
    mrr,
    faithfulness,
    p95LatencyMs: p95 === null ? null : Math.round(p95),
    abstentionRate,
  };
}
