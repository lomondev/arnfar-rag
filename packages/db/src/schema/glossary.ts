import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { ragChunk } from "./chunk.ts";

/** Lao↔EN accounting glossary — the crown jewel of the dataset.
 *  forbidden_lo[] is later injected into the chat system prompt as "never write these". */
export const laoTerm = pgTable(
  "lao_term",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    termLo: text("term_lo").notNull(),
    termLoSeg: text("term_lo_seg").notNull(),
    termEn: text("term_en").notNull(),
    definitionLo: text("definition_lo"),
    definitionEn: text("definition_en"),
    domain: text("domain").notNull().default("accounting"),
    variantsLo: text("variants_lo").array().notNull().default(sql`'{}'::text[]`),
    forbiddenLo: text("forbidden_lo").array().notNull().default(sql`'{}'::text[]`),
    sourceChunkId: uuid("source_chunk_id").references(() => ragChunk.id, {
      onDelete: "set null",
    }),
    verified: boolean("verified").notNull().default(false),
    verifiedBy: text("verified_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("lao_term_tenant_term_domain").on(t.hfId, t.companyId, t.termLo, t.domain),
    index("lao_term_en_trgm").using("gin", sql`term_en gin_trgm_ops`),
    index("lao_term_lo_trgm").using("gin", sql`term_lo gin_trgm_ops`),
  ],
);
