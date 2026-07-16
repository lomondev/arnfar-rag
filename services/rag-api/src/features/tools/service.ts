import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, ilike, or } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { search } from "../search/service.ts";

/**
 * Agent tools (ERP-RAG-VISION.md §AI Tools). Deterministic, tenant-scoped
 * lookups and calculators the agent can invoke alongside retrieval. Every tool
 * returns plain data — the generator still owes a [n] citation or an explicit
 * tool attribution for anything it claims.
 */

export interface ToolDescriptor {
  key: string;
  nameEn: string;
  description: string;
  params: Record<string, string>;
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    key: "coa_search",
    nameEn: "Chart of Accounts search",
    description:
      "Find accounts by code prefix or by Lao/English name fragment. Returns code, names, class, normal balance, statement, verified.",
    params: { q: "code prefix or name fragment", limit: "max rows (default 10)" },
  },
  {
    key: "glossary_lookup",
    nameEn: "Glossary lookup",
    description:
      "Look up Lao accounting terms and their English glosses (verified terms first).",
    params: { q: "Lao or English fragment", limit: "max rows (default 10)" },
  },
  {
    key: "vat_calc",
    nameEn: "VAT calculator",
    description:
      "Add VAT to a net LAK amount, or extract VAT from a gross amount. LAK is integer-only; rate is basis points (1000 = 10%). The rate must come from the user or a cited source — the tool never assumes one.",
    params: {
      amountLak: "integer LAK amount (string or number)",
      rateBp: "VAT rate in basis points, e.g. 1000 = 10%",
      mode: "'add' (amount is net) or 'extract' (amount is VAT-inclusive)",
    },
  },
  {
    key: "doc_search",
    nameEn: "Document search",
    description: "Hybrid (dense + lexical) search over the ingested document corpus.",
    params: { q: "natural-language query", k: "top-k (default 8)", collections: "optional collection filter" },
  },
];

export async function coaSearch(tenant: TenantContext, q: string, limit = 10) {
  const needle = `%${q}%`;
  return db()
    .select({
      code: schema.laoAccount.code,
      nameLo: schema.laoAccount.nameLo,
      nameEn: schema.laoAccount.nameEn,
      parentCode: schema.laoAccount.parentCode,
      accountClass: schema.laoAccount.accountClass,
      normalBalance: schema.laoAccount.normalBalance,
      statement: schema.laoAccount.statement,
      verified: schema.laoAccount.verified,
    })
    .from(schema.laoAccount)
    .where(
      and(
        eq(schema.laoAccount.hfId, tenant.hfId),
        eq(schema.laoAccount.companyId, tenant.companyId),
        or(
          ilike(schema.laoAccount.code, `${q}%`),
          ilike(schema.laoAccount.nameLo, needle),
          ilike(schema.laoAccount.nameEn, needle),
        ),
      ),
    )
    .orderBy(schema.laoAccount.code)
    .limit(Math.min(limit, 50));
}

export async function glossaryLookup(tenant: TenantContext, q: string, limit = 10) {
  const needle = `%${q}%`;
  const rows = await db()
    .select({
      termLo: schema.laoTerm.termLo,
      termEn: schema.laoTerm.termEn,
      definitionLo: schema.laoTerm.definitionLo,
      variantsLo: schema.laoTerm.variantsLo,
      verified: schema.laoTerm.verified,
    })
    .from(schema.laoTerm)
    .where(
      and(
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
        or(ilike(schema.laoTerm.termLo, needle), ilike(schema.laoTerm.termEn, needle)),
      ),
    )
    .limit(Math.min(limit, 50));
  // Verified terminology is authoritative — surface it first.
  return rows.sort((a, b) => Number(b.verified) - Number(a.verified));
}

export interface VatInput {
  amountLak: string | number;
  rateBp: number;
  mode: "add" | "extract";
}

export interface VatResult {
  mode: "add" | "extract";
  rateBp: number;
  netLak: string;
  vatLak: string;
  grossLak: string;
  note: string;
}

/** Integer LAK arithmetic (CLAUDE.md money rule): BigInt end-to-end, half-up
 *  rounding to the whole kip, no floats anywhere. */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function vatCalc(input: VatInput): VatResult {
  const raw = String(input.amountLak).replace(/[,\s]/g, "");
  if (!/^\d+$/.test(raw)) {
    throw new Error("amountLak must be a non-negative integer LAK amount (no decimals)");
  }
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 10000) {
    throw new Error("rateBp must be an integer between 0 and 10000 (1000 = 10%)");
  }
  const amount = BigInt(raw);
  const rate = BigInt(input.rateBp);

  if (input.mode === "add") {
    const vat = divHalfUp(amount * rate, 10000n);
    return {
      mode: "add",
      rateBp: input.rateBp,
      netLak: amount.toString(),
      vatLak: vat.toString(),
      grossLak: (amount + vat).toString(),
      note: "VAT added to net amount; rounded half-up to the whole kip",
    };
  }
  const net = divHalfUp(amount * 10000n, 10000n + rate);
  return {
    mode: "extract",
    rateBp: input.rateBp,
    netLak: net.toString(),
    vatLak: (amount - net).toString(),
    grossLak: amount.toString(),
    note: "VAT extracted from gross amount; rounded half-up to the whole kip",
  };
}

export async function docSearch(
  tenant: TenantContext,
  q: string,
  k = 8,
  collections?: string[],
) {
  const res = await search({
    query: q,
    ...(collections?.length ? { collections } : {}),
    k,
    tenant,
  });
  return res.hits;
}
