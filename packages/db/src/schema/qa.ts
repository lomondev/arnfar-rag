import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { qaSource, qaSplit } from "./enums.ts";

/** QA pairs — the SFT dataset. citation_ids MUST be non-empty and reference
 *  non-rejected chunks to be exportable (enforced in the export query). */
export const laoQaPair = pgTable(
  "lao_qa_pair",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    collection: text("collection").notNull(),
    questionLo: text("question_lo").notNull(),
    questionEn: text("question_en"),
    answerLo: text("answer_lo").notNull(),
    answerEn: text("answer_en"),
    reasoningLo: text("reasoning_lo"),
    citationIds: uuid("citation_ids").array().notNull().default(sql`'{}'::uuid[]`),
    difficulty: smallint("difficulty").notNull().default(2),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    source: qaSource("source").notNull(),
    split: qaSplit("split").notNull().default("unassigned"),
    verified: boolean("verified").notNull().default(false),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lao_qa_verified").on(t.hfId, t.companyId, t.verified, t.split),
    index("lao_qa_tags_gin").using("gin", t.tags),
    check("lao_qa_difficulty_chk", sql`${t.difficulty} BETWEEN 1 AND 5`),
  ],
);
