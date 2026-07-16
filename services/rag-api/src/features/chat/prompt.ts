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
      const body =
        s.content.length > MAX_SOURCE_CHARS
          ? `${s.content.slice(0, MAX_SOURCE_CHARS)}…`
          : s.content;
      return `[${s.n}] (${head}${auth}${eff})\n${body}`;
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
