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
  /** Set when this source's document has been replaced. null = current. */
  superseded: { title: string; effectiveDate: string | null } | null;
  /** "dataset" = a verified rag_chunk; "web" = an unverified internet page;
   *  "erp" = a live read-only figure from the ERP database (point-in-time, exact). */
  origin: "dataset" | "web" | "erp";
  url: string | null;
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
    superseded: h.superseded_by_title
      ? { title: h.superseded_by_title, effectiveDate: h.superseded_by_effective_date }
      : null,
    origin: "dataset" as const,
    url: null,
  }));
}

/** Web hits → citation sources, numbered AFTER the dataset sources so [n] stays a
 *  single sequence. Web text is unverified: it never becomes a dataset citation
 *  (no chunk id — promote filters on origin). */
export function webToSources(
  results: Array<{ title: string; url: string; snippet: string; content: string }>,
  startN: number,
): CitationSource[] {
  return results.map((r, i) => ({
    n: startN + i + 1,
    id: `web:${r.url}`,
    content: r.content || r.snippet,
    headingPath: [],
    kind: "web",
    title: r.title,
    authority: null,
    effectiveDate: null,
    superseded: null,
    origin: "web" as const,
    url: r.url,
  }));
}

/** The Lao accounting persona (PROMPT.md §Phase 7). Verified glossary terms are the
 *  ONLY allowed terminology; forbidden_lo forms are injected as a do-not-use list. */
export function buildSystemPrompt(
  glossary: Array<{ termLo: string; termEn: string }>,
  forbidden: string[],
  hasWeb = false,
  hasErp = false,
  hasSuperseded = false,
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
    hasSuperseded
      ? "- A source marked ⚠ SUPERSEDED is NO LONGER IN FORCE. Never present it as the current rule: say plainly in Lao that it was replaced, name the replacement and its effective date, and answer from the replacement when it is also in the context. Quote the superseded figure only when the question is explicitly about that earlier period."
      : "",
    terms,
    forbid,
    hasWeb
      ? "Sources marked (web: url) are internet pages — UNVERIFIED. Prefer dataset sources when they conflict; when a claim rests only on a (web) source, cite it with [n] and name the website."
      : "",
    hasErp
      ? "Sources marked (erp) are LIVE figures from the company's ERP system — exact and current. Quote the numbers precisely as given (integer LAK, thousands-separated) and cite them with [n]."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cap each source in the prompt so a large table chunk can't bloat the context
 *  and stall generation. The full text still reaches the UI via the citations frame. */
const MAX_SOURCE_CHARS = 700;

export function buildContext(sources: CitationSource[]): string {
  if (!sources.length) return "(no relevant documents found)";
  return sources
    .map((s) => {
      const head = s.headingPath.length ? s.headingPath.join(" › ") : s.title;
      const auth = s.authority ? `, authority: ${s.authority}` : "";
      const eff = s.effectiveDate ? `, effective: ${s.effectiveDate}` : "";
      const web = s.origin === "web" ? ` (web: ${s.url})` : s.origin === "erp" ? " (erp: live system data)" : "";
      // Rendered inline so the warning cannot be separated from the text it qualifies.
      const sup = s.superseded
        ? `, ⚠ SUPERSEDED by "${s.superseded.title}"${s.superseded.effectiveDate ? ` effective ${s.superseded.effectiveDate}` : ""}`
        : "";
      // Web pages get a larger slice: unlike a curated chunk, the answer-bearing
      // sentence is often buried mid-page, and 700 chars cuts it off.
      const cap = s.origin === "web" ? 1600 : MAX_SOURCE_CHARS;
      const body = s.content.length > cap ? `${s.content.slice(0, cap)}…` : s.content;
      return `[${s.n}] (${head}${auth}${eff}${sup}${web})\n${body}`;
    })
    .join("\n\n");
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Format prior turns so the LLM sees the conversation. Prior-assistant answers are
 *  trimmed (their old [n] citations are now stale text — only the *current* retrieval
 *  set's [n] are live citations, so we never let old markers confuse the model). */
export function buildHistory(turns: HistoryTurn[]): string {
  if (!turns.length) return "";
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

/** Build the full prompt: optional conversation history → retrieved context → question.
 *  When there is no history this collapses to the original single-turn prompt. */
export function buildPrompt(question: string, sources: CitationSource[], history: HistoryTurn[]): string {
  const context = buildContext(sources);
  const hist = buildHistory(history);
  const parts: string[] = [];
  if (hist) parts.push(`[Conversation so far]\n${hist}`);
  parts.push(`[Retrieved context for the current question]\n${context}`);
  parts.push(`Question: ${question}`);
  parts.push("Answer (cite [n] or state it is not in the documents):");
  return parts.join("\n\n");
}
