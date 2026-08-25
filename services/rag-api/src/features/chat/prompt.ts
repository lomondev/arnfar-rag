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
   *  "erp" = a live read-only figure from the ERP database (point-in-time, exact);
   *  "calc" = computed here from values the user supplied (exact for those inputs only). */
  origin: "dataset" | "web" | "erp" | "calc";
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
    "You are an expert Lao accountant answering for accounting staff in Laos.",
    "Language rules:",
    "- Answer in the user's language. A Lao question gets a Lao answer in formal written register (ພາສາຂຽນທາງການ). Never translate the source content.",
    '- Write pure Lao script only. Never mix in Thai characters or Thai spellings — Lao and Thai are different languages. Copy Lao words from the sources letter-for-letter; never respell or "correct" them.',
    // The retrieved context is space-segmented (the seeded corpus was authored that way),
    // and a generator copies the register it is shown. Say the rule explicitly so the model
    // does not imitate the defect; the deterministic joiner in features/lao/clean.ts repairs
    // whatever still slips through.
    "- Lao spacing: write words joined, with NO space between them (ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມ), which is standard Lao orthography. Use a space only at a phrase or clause boundary, and around numbers, Latin words and punctuation. Some sources below are stored with a space between every word — that is a storage artefact, NOT a model to copy.",
    // Without this the previous rule is followed too literally and the country's name comes
    // out as ສປປລາວ. The deterministic joiner protects this space when it is present, but it
    // cannot insert one the generator never wrote.
    "- Initialisms keep their spaces: write ສປປ ລາວ, never ສປປລາວ. Same for any abbreviation written as bare consonants before the word it qualifies.",
    // Clause punctuation has to come from here. A post-processor cannot place a comma
    // without knowing which constituent a qualifier attaches to, and in tax law the
    // attachment IS the rule — see the note on repairLaoAnswer in features/lao/clean.ts.
    "- Lao paragraph style: separate clauses with a space, and use a comma (,) between items in a list and before a contrasting clause. End every sentence with a full stop (.). Put a space after , and . but never before them.",
    "- Never write a whole paragraph as one unbroken run of Lao. A sentence that would run past roughly 25 words is two sentences — break it.",
    "- Use a bullet list (- ) for three or more parallel items, and a markdown table when the answer compares the same fields across several rows. Do not put a full stop after a bullet that is a bare noun phrase.",
    "- Lao digits ໐໑໒໓໔໕໖໗໘໙ = 0123456789. Lao scale words: ຮ້ອຍ = 100, ພັນ = 1,000, ໝື່ນ = 10,000, ແສນ = 100,000, ລ້ານ = 1,000,000, ຕື້ = 1,000,000,000. Read and write amounts with these exact values — confusing ໝື່ນ with ແສນ is a serious accounting error. Currency is Lao kip (ກີບ, LAK) unless a source states otherwise.",
    "Answer rules:",
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
/** Web pages get a larger slice: unlike a curated chunk, the answer-bearing
 *  sentence is often buried mid-page, and 700 chars cuts it off. */
const MAX_WEB_SOURCE_CHARS = 1600;
/** Total char budget across ALL sources. The whole prompt must tokenize under
 *  num_ctx (8192, see lib/env.ts) or Ollama context-shifts the prompt head — the
 *  system prompt — out of the window. Lao runs ≈2–2.5 chars/token on Gemma2's
 *  tokenizer, so 10k chars of sources ≈ 4–5k tokens, leaving headroom for the
 *  system prompt, history, question, and a 1024-token answer. */
const CONTEXT_CHAR_BUDGET = 10_000;
/** Floor per source when the budget forces scaling — below this a chunk is noise. */
const MIN_SOURCE_CHARS = 250;

/** Per-source char caps: the usual per-kind cap, scaled down proportionally when
 *  the sum would overflow the total budget (large k + web search stacked up). */
function sourceCaps(sources: CitationSource[]): number[] {
  const want = sources.map((s) =>
    Math.min(s.origin === "web" ? MAX_WEB_SOURCE_CHARS : MAX_SOURCE_CHARS, s.content.length),
  );
  const total = want.reduce((a, b) => a + b, 0);
  if (total <= CONTEXT_CHAR_BUDGET) return want;
  const scale = CONTEXT_CHAR_BUDGET / total;
  return want.map((w) => Math.max(MIN_SOURCE_CHARS, Math.floor(w * scale)));
}

export function buildContext(sources: CitationSource[]): string {
  if (!sources.length) return "(no relevant documents found)";
  const caps = sourceCaps(sources);
  return sources
    .map((s, i) => {
      const head = s.headingPath.length ? s.headingPath.join(" › ") : s.title;
      const auth = s.authority ? `, authority: ${s.authority}` : "";
      const eff = s.effectiveDate ? `, effective: ${s.effectiveDate}` : "";
      const web =
        s.origin === "web"
          ? ` (web: ${s.url})`
          : s.origin === "erp"
            ? " (erp: live system data)"
            : "";
      // Rendered inline so the warning cannot be separated from the text it qualifies.
      const sup = s.superseded
        ? `, ⚠ SUPERSEDED by "${s.superseded.title}"${s.superseded.effectiveDate ? ` effective ${s.superseded.effectiveDate}` : ""}`
        : "";
      const cap = caps[i]!;
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
  return turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n");
}

/** Build the full prompt: optional conversation history → retrieved context → question.
 *  When there is no history this collapses to the original single-turn prompt. */
export function buildPrompt(
  question: string,
  sources: CitationSource[],
  history: HistoryTurn[],
  /** Values the user supplied with this question (see chat/values.ts). Placed AFTER the
   *  retrieved context and immediately before the question, because it is the most
   *  specific instruction in the prompt and the last thing read carries the most weight. */
  givenValues = "",
): string {
  const context = buildContext(sources);
  const hist = buildHistory(history);
  const parts: string[] = [];
  if (hist) parts.push(`[Conversation so far]\n${hist}`);
  parts.push(`[Retrieved context for the current question]\n${context}`);
  if (givenValues) parts.push(`[Given values]\n${givenValues}`);
  parts.push(`Question: ${question}`);
  parts.push("Answer (cite [n] or state it is not in the documents):");
  return parts.join("\n\n");
}
