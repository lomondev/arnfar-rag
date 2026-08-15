import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
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

  const rewrite = await rewriteSuggestion(tenant, norm.normalized, terms, spelling, terminology);

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

/** Minimal-edit correction, NOT a free rewrite. An earlier "improve this text" prompt
 *  made the model paraphrase — it swapped ເງິນສົດ (cash) for ທຶນ/ເງິນຝາກ and silently
 *  changed the meaning of correct sentences. The rewrite now only applies the defects
 *  the deterministic checkers found (plus obvious typos), at temperature 0, and must
 *  return the text unchanged when there is nothing to fix. */
async function rewriteSuggestion(
  tenant: TenantContext,
  text: string,
  terms: Array<{ termLo: string; termEn: string }>,
  spelling: SpellingIssue[],
  terminology: TerminologyViolation[],
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

  // The checkers' findings become explicit edit instructions — the model applies
  // them; it does not get to decide what else to "improve".
  const fixes: string[] = [];
  for (const v of terminology) {
    fixes.push(`Replace every "${v.found}" with "${v.useInstead}" (${v.termEn}).`);
  }
  for (const s of spelling) {
    if (s.suggestions.length) {
      fixes.push(`"${s.token}" looks misspelled — likely ${s.suggestions.slice(0, 3).join(" or ")}.`);
    }
  }

  const system = [
    "You are a careful Lao accounting copy-editor. Produce a MINIMAL correction of the text.",
    "- Apply ONLY the required fixes listed, plus obvious spelling/spacing mistakes.",
    "- Never replace a word with a different word of different meaning. Never change numbers, amounts, dates, or account codes.",
    "- Pure Lao script only — never introduce Thai characters or Thai spellings.",
    "- If nothing needs fixing, output the text EXACTLY as given.",
    "- Output ONLY the corrected Lao text — no explanation, no quotes.",
  ].join("\n");

  return generate(
    (glossary ? `Approved terminology: ${glossary}\n` : "") +
      (styleContext ? `Style reference:\n${styleContext}\n` : "") +
      `Required fixes:\n${fixes.length ? fixes.map((f) => `- ${f}`).join("\n") : "- (none found — change nothing unless you see an obvious typo)"}\n\n` +
      `Text:\n${text}\n\nCorrected text:`,
    // LaoNLP finds the defects; the Lao-tuned Gemma applies them (env.laoCorrectModel).
    { system, temperature: 0, maxTokens: 400, model: env.laoCorrectModel },
  );
}
