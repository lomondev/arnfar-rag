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
