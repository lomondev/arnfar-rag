import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { embedOne } from "../../lib/ollama.ts";
import { segment } from "../../lib/sidecars.ts";
import { ragAnswer } from "./generate.ts";
import { judgeFaithfulness } from "./judge.ts";
import { hitRank, mean, percentile, recallAtK, reciprocalRank } from "./metrics.ts";
import { retrieve, type Retriever } from "./retrievers.ts";

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

  const runId = newId();
  await db().insert(schema.evalRun).values({
    id: runId,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    embedModel: "bge-m3",
    genModel: cfg.genModel,
    retriever: cfg.retriever,
    params: { collections, top_k: TOP_K, judge_model: cfg.judgeModel, generate: cfg.generate },
    nQueries: pairs.length,
  });

  const r5: number[] = [];
  const r10: number[] = [];
  const rr: number[] = [];
  const latencies: number[] = [];
  const faith: number[] = [];

  for (const p of pairs) {
    const [seg, emb] = await Promise.all([segment(p.questionLo), embedOne(p.questionLo)]);
    const t0 = performance.now();
    const retrieved = await retrieve(cfg.retriever, {
      tenant,
      collections,
      queryEmbedding: emb,
      querySeg: seg.seg_text,
      k: TOP_K,
    });
    const latency = Math.round(performance.now() - t0);
    latencies.push(latency);

    const gold = p.citationIds;
    r5.push(recallAtK(retrieved, gold, 5));
    r10.push(recallAtK(retrieved, gold, 10));
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
      const [seg, emb] = await Promise.all([segment(q), embedOne(q)]);
      const retrieved = await retrieve(cfg.retriever, {
        tenant,
        collections,
        queryEmbedding: emb,
        querySeg: seg.seg_text,
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
  const mrr = mean(rr);
  const faithfulness = cfg.generate ? mean(faith) : null;
  const p95 = Math.round(percentile(latencies, 95));

  await db()
    .update(schema.evalRun)
    .set({
      recallAt5: recall5.toFixed(4),
      recallAt10: recall10.toFixed(4),
      mrr: mrr.toFixed(4),
      faithfulness: faithfulness === null ? null : faithfulness.toFixed(4),
      p95LatencyMs: p95,
      notes: abstentionRate === null ? null : `abstention_on_adversarial=${abstentionRate.toFixed(2)}`,
    })
    .where(eq(schema.evalRun.id, runId));

  return {
    runId,
    retriever: cfg.retriever,
    genModel: cfg.genModel,
    nQueries: pairs.length,
    recallAt5: recall5,
    recallAt10: recall10,
    mrr,
    faithfulness,
    p95LatencyMs: p95,
    abstentionRate,
  };
}
