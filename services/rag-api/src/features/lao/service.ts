import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { generate } from "../../lib/ollama.ts";
import { normalize, spellcheck } from "../../lib/sidecars.ts";
import { search } from "../search/service.ts";

/** Honest scope (CLAUDE.md / PROMPT.md §Phase 8): LaoNLP gives tokenization + a
 *  word list — that is SPELL-CHECKING, not grammar correction. No open Lao GEC model
 *  exists. The LLM rewrite is a SUGGESTION requiring human review. */
export const LAO_CHECK_DISCLAIMER =
  "ຂໍ້ສະເໜີ AI — ຕ້ອງກວດຄືນໂດຍຄົນ. LaoNLP ໃຫ້ການກວດຄຳສະກົດ (ບໍ່ແມ່ນໄວຍະກອນ). " +
  "The rewrite is an AI suggestion requiring human review — LaoNLP provides spell-" +
  "checking, not grammar correction. No open Lao grammar-correction model exists.";

export interface SpellingIssue {
  token: string;
  suggestions: string[];
}

export interface TerminologyViolation {
  found: string; // the forbidden form present in the text
  useInstead: string; // the approved term_lo
  termEn: string;
}

export interface LaoCheckResult {
  original: string;
  normalized: string;
  zeroWidthRemoved: number;
  lang: string;
  spelling: SpellingIssue[];
  terminology: TerminologyViolation[];
  rewrite: string;
  disclaimer: string;
}

export async function checkLao(tenant: TenantContext, text: string): Promise<LaoCheckResult> {
  const [norm, spell] = await Promise.all([normalize(text), spellcheck(text)]);

  const spelling: SpellingIssue[] = spell.tokens
    .filter((t) => t.is_lao && !t.in_dictionary)
    .map((t) => ({ token: t.token, suggestions: t.suggestions }));

  // Terminology: any verified forbidden_lo form present in the text.
  const terms = await db()
    .select({
      termLo: schema.laoTerm.termLo,
      termEn: schema.laoTerm.termEn,
      forbiddenLo: schema.laoTerm.forbiddenLo,
    })
    .from(schema.laoTerm)
    .where(
      and(
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
        eq(schema.laoTerm.verified, true),
      ),
    );
  const terminology: TerminologyViolation[] = [];
  for (const t of terms) {
    for (const bad of t.forbiddenLo) {
      if (bad && text.includes(bad)) {
        terminology.push({ found: bad, useInstead: t.termLo, termEn: t.termEn });
      }
    }
  }

  const rewrite = await rewriteSuggestion(tenant, norm.normalized, terms);

  return {
    original: text,
    normalized: norm.normalized,
    zeroWidthRemoved: norm.zero_width_removed,
    lang: norm.lang,
    spelling,
    terminology,
    rewrite,
    disclaimer: LAO_CHECK_DISCLAIMER,
  };
}

async function rewriteSuggestion(
  tenant: TenantContext,
  text: string,
  terms: Array<{ termLo: string; termEn: string }>,
): Promise<string> {
  // Ground the rewrite in the lao-style collection (if any) + verified glossary.
  let styleContext = "";
  try {
    const style = await search({
      query: text,
      collections: ["lao-style"],
      k: 3,
      tenant,
    });
    styleContext = style.hits.map((h) => h.content).join("\n");
  } catch {
    styleContext = "";
  }
  const glossary = terms.length
    ? terms.map((t) => `${t.termLo} = ${t.termEn}`).join("; ")
    : "";

  const system =
    "You improve Lao accounting text. Rewrite in clear, standard Lao using ONLY the " +
    "approved terminology. Keep the meaning. Output ONLY the rewritten Lao text.";
  return generate(
    `Approved terminology: ${glossary || "(none)"}\n` +
      `Style reference:\n${styleContext || "(none)"}\n\n` +
      `Rewrite this Lao text:\n${text}`,
    { system, temperature: 0.3, maxTokens: 400 },
  );
}
