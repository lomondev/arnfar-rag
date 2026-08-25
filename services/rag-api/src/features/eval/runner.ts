import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { newId } from "../../lib/ids.ts";
import { rerankAvailable } from "../../lib/sidecars.ts";
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

export interface EvalConfig {
  retriever: Retriever;
  genModel: string;
  judgeModel: string;
  collections: string[];
  generate: boolean; // run generation + faithfulness (slow)
  adversarial: string[]; // Lao questions whose answer is NOT in the corpus
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

export async function runEval(tenant: TenantContext, cfg: EvalConfig) {
  const collections = cfg.collections;

  // Eval set = verified QA pairs; gold = their citations.
  const pairs = await db()
    .select()
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
        eq(schema.laoQaPair.verified, true),
      ),
    );

  // Refuse before any row exists. A run over zero gold queries used to write
  // recall=0.0000 / faithfulness=0.0000 / p95=0ms into the ledger — numbers that read as a
  // broken retriever and are in fact a measurement that never happened. Three such rows are
  // already on record in this database.
  const sample = sampleVerdict(pairs.length);
  if (!sample.usable) {
    throw new EvalPreconditionError(
      `cannot evaluate: ${sample.note}`,
      "verify QA pairs in /studio/teach or /studio/qa — the eval set is `lao_qa_pair` " +
        "WHERE verified = true, and an unverified draft is not gold.",
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
      params: { collections, top_k: TOP_K, judge_model: cfg.judgeModel, generate: cfg.generate },
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
    const prepared = await prepareQuery(p.questionLo, tenant);
    const t0 = performance.now();
    const retrieved = await retrieve(cfg.retriever, {
      tenant,
      collections,
      queryEmbedding: prepared.queryEmbedding,
      querySeg: prepared.querySeg,
      queryText: p.questionLo,
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
