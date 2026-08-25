import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { laoQaPair } from "./qa.ts";

export const evalRun = pgTable("eval_run", {
  id: uuid("id").primaryKey(),
  hfId: uuid("hf_id").notNull(),
  companyId: uuid("company_id").notNull(),
  embedModel: text("embed_model").notNull(),
  genModel: text("gen_model").notNull(),
  retriever: text("retriever").notNull(), // dense | lexical | hybrid-rrf
  params: jsonb("params").notNull().default({}),
  recallAt5: numeric("recall_at_5", { precision: 5, scale: 4 }),
  recallAt10: numeric("recall_at_10", { precision: 5, scale: 4 }),
  mrr: numeric("mrr", { precision: 5, scale: 4 }),
  // Precision and NDCG joined recall/MRR so a run records ranking quality, not just
  // presence. recall@5 answers "did the source reach the window"; ndcg@10 answers "was it
  // at the top of it" — a generator with a 5-chunk window can fail on the second while the
  // first looks fine. precision@5 is a tripwire for junk climbing into the context, and is
  // read against a gold set of 1–2 citations (see metrics.ts).
  precisionAt5: numeric("precision_at_5", { precision: 5, scale: 4 }),
  ndcgAt10: numeric("ndcg_at_10", { precision: 5, scale: 4 }),
  hitRateAt5: numeric("hit_rate_at_5", { precision: 5, scale: 4 }),
  faithfulness: numeric("faithfulness", { precision: 5, scale: 4 }),
  p95LatencyMs: integer("p95_latency_ms"),
  nQueries: integer("n_queries").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const evalResult = pgTable("eval_result", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => evalRun.id, { onDelete: "cascade" }),
  qaPairId: uuid("qa_pair_id")
    .notNull()
    .references(() => laoQaPair.id, { onDelete: "cascade" }),
  retrievedIds: uuid("retrieved_ids").array().notNull().default(sql`'{}'::uuid[]`),
  hitRank: integer("hit_rank"), // NULL = miss
  answerLo: text("answer_lo"),
  judgeScore: smallint("judge_score"),
  judgeReason: text("judge_reason"),
  latencyMs: integer("latency_ms").notNull(),
});
