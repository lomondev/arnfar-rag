import type { SearchHit } from "../search/query.ts";

export interface CitationSource {
  n: number;
  id: string;
  content: string;
  headingPath: string[];
  kind: string;
  title: string;
  authority: string | null;
  effectiveDate: string | null;
}

export function toSources(hits: SearchHit[]): CitationSource[] {
  return hits.map((h, i) => ({
    n: i + 1,
    id: h.id,
    content: h.content,
    headingPath: h.heading_path,
    kind: h.kind,
    title: h.title,
    authority: h.authority,
    effectiveDate: h.effective_date,
  }));
}

/** The Lao accounting persona (PROMPT.md §Phase 7). Verified glossary terms are the
 *  ONLY allowed terminology; forbidden_lo forms are injected as a do-not-use list. */
export function buildSystemPrompt(
  glossary: Array<{ termLo: string; termEn: string }>,
  forbidden: string[],
): string {
  const terms = glossary.length
    ? "Approved terminology (use ONLY these Lao terms):\n" +
      glossary.map((t) => `- ${t.termLo} = ${t.termEn}`).join("\n")
    : "";
  const forbid = forbidden.length
    ? `NEVER write these incorrect forms: ${forbidden.join(", ")}.`
    : "";
  return [
    "You are a Lao accounting assistant.",
    "- Answer in the user's language. A Lao question gets a Lao answer. Never translate the source content.",
    "- Cite or abstain: every factual claim must carry a [n] citation to a numbered context source below. If the context does not support an answer, say so plainly in Lao — never invent tax rates, amounts, or account codes.",
    "- All LAK amounts are integers, thousands-separated, no decimals.",
    "- Quote account codes exactly as they appear in the context.",
    "- When citing law, state the authority and effective date; if a source is superseded, say so.",
    terms,
    forbid,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildContext(sources: CitationSource[]): string {
  if (!sources.length) return "(no relevant documents found)";
  return sources
    .map((s) => {
      const head = s.headingPath.length ? s.headingPath.join(" › ") : s.title;
      const auth = s.authority ? `, authority: ${s.authority}` : "";
      const eff = s.effectiveDate ? `, effective: ${s.effectiveDate}` : "";
      return `[${s.n}] (${head}${auth}${eff})\n${s.content}`;
    })
    .join("\n\n");
}
