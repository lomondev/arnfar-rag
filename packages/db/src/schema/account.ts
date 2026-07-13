import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { ragDocument } from "./document.ts";

/** Chart of accounts — structured extraction. verified=false until a human confirms. */
export const laoAccount = pgTable(
  "lao_account",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").references(() => ragDocument.id, {
      onDelete: "set null",
    }),
    code: text("code").notNull(),
    nameLo: text("name_lo").notNull(),
    nameEn: text("name_en"),
    parentCode: text("parent_code"),
    accountClass: text("account_class").notNull(), // asset|liability|equity|revenue|expense
    normalBalance: text("normal_balance").notNull(),
    statement: text("statement").notNull(),
    verified: boolean("verified").notNull().default(false),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => [
    unique("lao_account_tenant_code").on(t.hfId, t.companyId, t.code),
    index("lao_account_parent").on(t.hfId, t.companyId, t.parentCode),
    check(
      "lao_account_normal_balance_chk",
      sql`${t.normalBalance} IN ('debit','credit')`,
    ),
    check("lao_account_statement_chk", sql`${t.statement} IN ('BS','PL','CF','NONE')`),
  ],
);
