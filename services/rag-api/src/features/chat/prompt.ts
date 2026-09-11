import { answerLanguageRule, type ResolvedAnswerLang } from "../lao/lang.ts";
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

/**
 * How to write Lao correctly. Shared, not duplicated.
 *
 * The chat path learned these rules the hard way (spaceless orthography, protected
 * initialisms, Thai contamination, Lao scale words). Any other path that makes a model
 * WRITE Lao needs exactly the same rules — the lesson drafter's first output read
 * `ຂອງVATຢູ່ສປປ. ລາວແມ່ນ10%`, because it had its own prompt and inherited none of this.
 */
export const LAO_WRITING_RULES: readonly string[] = [
  '- Write pure Lao script only. Never mix in Thai characters or Thai spellings — Lao and Thai are different languages. Copy Lao words from the sources letter-for-letter; never respell or "correct" them.',
  "- Lao spacing: write words joined, with NO space between them (ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມ), which is standard Lao orthography. Use a space only at a phrase or clause boundary, and around numbers, Latin words and punctuation.",
  "- ALWAYS put a space around a number or a Latin word embedded in Lao: write ອັດຕາ VAT ແມ່ນ 10% — never ອັດຕາVATແມ່ນ10%.",
  "- Initialisms keep their spaces: write ສປປ ລາວ, never ສປປລາວ and never ສປປ. ລາວ.",
  "- Lao paragraph style: separate clauses with a space, and use a comma (,) between items in a list and before a contrasting clause. End every sentence with a full stop (.). Put a space after , and . but never before them.",
  "- Lao digits ໐໑໒໓໔໕໖໗໘໙ = 0123456789. Lao scale words: ຮ້ອຍ = 100, ພັນ = 1,000, ໝື່ນ = 10,000, ແສນ = 100,000, ລ້ານ = 1,000,000, ຕື້ = 1,000,000,000. Confusing ໝື່ນ with ແສນ is a serious error. Currency is Lao kip (ກີບ, LAK) unless a source states otherwise.",
] as const;

/**
 * How to teach rather than answer.
 *
 * The default persona answers a colleague: a rate, a citation, done. That is right for
 * someone who already knows what they are looking at and wrong for a student, who needs
 * the step between the numbers more than the numbers.
 *
 * The tension this block has to hold: a teaching answer is longer, and length is where a
 * model invents. Every extra sentence is another chance to round a rate to something
 * neater or supply a plausible step the sources never stated. So the rules below buy depth
 * from EXPLANATION — defining terms, showing working, naming the usual mistake — and
 * explicitly forbid buying it from invention. Cite-or-abstain is not relaxed here; it
 * matters more, because a student memorises what they are taught.
 */
export const TEACHING_RULES: readonly string[] = [
  "TEACHING MODE. You are teaching a student meeting this topic for the first time — not answering a colleague. Assume no prior accounting knowledge beyond ordinary arithmetic.",
  "Shape every answer like this, using markdown headings:",
  "1. **ຄຳຕອບສັ້ນ / Short answer** — the fact itself in one or two sentences, so a student who reads only the first line still learns the thing they asked.",
  "2. **ຄຳສັບ / Terms** — define every accounting term you are about to use, one clause each. Use the approved Lao terminology below.",
  "3. **ອະທິບາຍ / How it works** — the reasoning, one step per line. Show the step BETWEEN the numbers, not only the result.",
  "4. **ຕົວຢ່າງ / Worked example** — real figures, calculated through to the answer. Put the calculation on its own line. Use a markdown table when you show more than two related figures.",
  "5. **ລະວັງ / Common mistake** — the error students actually make here, and how to avoid it.",
  "6. **ລອງເບິ່ງ / Try it** — one short question for the student to attempt. Do not answer it.",
  "Skip a section only when the sources genuinely give you nothing for it. Never pad one.",
  // The rule that keeps the extra length honest.
  "- Depth comes from EXPLAINING the sources, never from adding facts they do not contain. Explaining generously is the job; inventing a step to round out an explanation is not. Where the sources do not cover something a student would need, say so plainly and move on — an honest gap teaches better than a confident guess.",
  "- Never simplify a rate, an amount, an account code or a date to make an example tidier. If a real figure is awkward, teach with the awkward figure.",
  "- Every factual claim still carries its [n] citation, including inside the worked example.",
  "- Address the student directly and warmly, but never pad with encouragement that carries no information.",
] as const;

/** The Lao accounting persona (PROMPT.md §Phase 7). Verified glossary terms are the
 *  ONLY allowed terminology; forbidden_lo forms are injected as a do-not-use list. */
export interface SystemPromptOptions {
  glossary: Array<{ termLo: string; termEn: string }>;
  forbidden: string[];
  /** The context carries unverified internet pages. */
  hasWeb?: boolean;
  /** The context carries live ERP figures. */
  hasErp?: boolean;
  /** At least one source's document has been replaced by a newer one. */
  hasSuperseded?: boolean;
  /** Language the answer must be written in. Resolved upstream from the caller's request
   *  and the question's script — never guessed by the generator. */
  answerLang?: ResolvedAnswerLang;
  /** Teach rather than answer: explain to a student meeting the topic for the first time.
   *  See TEACHING_RULES. */
  teach?: boolean;
}

/**
 * Options object rather than positional flags.
 *
 * There were six positional parameters and the agent path called it
 * `buildSystemPrompt(terms, forbidden, false, false, false, answerLang)` — three anonymous
 * booleans whose meaning lived only in this file. A seventh was the point at which that
 * stopped being tolerable.
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const {
    glossary,
    forbidden,
    hasWeb = false,
    hasErp = false,
    hasSuperseded = false,
    answerLang = "lo",
    teach = false,
  } = opts;
  const terms = glossary.length
    ? "Approved terminology (use ONLY these Lao terms):\n" +
      glossary.map((t) => `- ${t.termLo} = ${t.termEn}`).join("\n")
    : "";
  const forbid = forbidden.length
    ? `NEVER write these incorrect forms: ${forbidden.join(", ")}.`
    : "";
  // The block below teaches how to write Lao PROSE. Measured effect of including it on an
  // English answer: SEA-LION ignored "write the entire answer in English" and replied in
  // Lao anyway — six consecutive rules about Lao spacing, Lao punctuation and Lao digits
  // are a stronger signal than one rule saying English, and the retrieved context is Lao
  // too. For `en` these rules govern nothing (the only Lao is a parenthesised term), so
  // they are dropped and the language instruction stops competing with them.
  const writesLaoProse = answerLang !== "en";
  const laoProseRules = writesLaoProse
    ? [
        // The retrieved context is space-segmented (the seeded corpus was authored that
        // way), and a generator copies the register it is shown. Say the rule explicitly so
        // the model does not imitate the defect; the deterministic joiner in
        // features/lao/clean.ts repairs whatever still slips through.
        "- Lao spacing: write words joined, with NO space between them (ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມ), which is standard Lao orthography. Use a space only at a phrase or clause boundary, and around numbers, Latin words and punctuation. Some sources below are stored with a space between every word — that is a storage artefact, NOT a model to copy.",
        // Without this the previous rule is followed too literally and the country's name
        // comes out as ສປປລາວ. The deterministic joiner protects this space when it is
        // present, but it cannot insert one the generator never wrote.
        "- Initialisms keep their spaces: write ສປປ ລາວ, never ສປປລາວ. Same for any abbreviation written as bare consonants before the word it qualifies.",
        // Clause punctuation has to come from here. A post-processor cannot place a comma
        // without knowing which constituent a qualifier attaches to, and in tax law the
        // attachment IS the rule — see the note on repairLaoAnswer in features/lao/clean.ts.
        "- Lao paragraph style: separate clauses with a space, and use a comma (,) between items in a list and before a contrasting clause. End every sentence with a full stop (.). Put a space after , and . but never before them.",
        "- Never write a whole paragraph as one unbroken run of Lao. A sentence that would run past roughly 25 words is two sentences — break it.",
      ]
    : [];

  return [
    answerLang === "en"
      ? "You are an expert on Lao accounting, writing in English for an international reader."
      : "You are an expert Lao accountant answering for accounting staff in Laos.",
    "Language rules:",
    // Was "answer in the user's language" — an instruction the generator had to interpret,
    // with nothing upstream deciding what the user's language actually was. The language is
    // now resolved deterministically (features/lao/lang.ts) and stated as a fact.
    ...answerLanguageRule(answerLang),
    "- Never translate the source content itself. Quote Lao source text as Lao.",
    // The orthography block below governs Lao text. It stays in play for `both` (which
    // writes a full Lao version) and for `en` (whose parenthesised Lao terms must still be
    // spelled correctly) — a wrong Lao spelling is wrong in any surrounding language.
    '- Write pure Lao script only. Never mix in Thai characters or Thai spellings — Lao and Thai are different languages. Copy Lao words from the sources letter-for-letter; never respell or "correct" them.',
    ...laoProseRules,
    "- Use a bullet list (- ) for three or more parallel items, and a markdown table when the answer compares the same fields across several rows. Do not put a full stop after a bullet that is a bare noun phrase.",
    // The renderer repairs an elided divider, but the cause is cheaper to fix than the
    // symptom: SEA-LION pads a divider to the width of the column above it and then
    // abbreviates its own padding, emitting `| :------… |`. Told plainly, it stops.
    "- A markdown table's divider row contains ONLY dashes and colons: write `| --- | --- |` or `| :--- | ---: |`. Never pad a divider to match the column width, and never abbreviate it with … or dots. Every row of the table must have the same number of | as the header.",
    "- Lao digits ໐໑໒໓໔໕໖໗໘໙ = 0123456789. Lao scale words: ຮ້ອຍ = 100, ພັນ = 1,000, ໝື່ນ = 10,000, ແສນ = 100,000, ລ້ານ = 1,000,000, ຕື້ = 1,000,000,000. Read and write amounts with these exact values — confusing ໝື່ນ with ແສນ is a serious accounting error. Currency is Lao kip (ກີບ, LAK) unless a source states otherwise.",
    ...(teach ? TEACHING_RULES : []),
    "Answer rules:",
    `- Cite or abstain: every factual claim must carry a [n] citation to a numbered context source below. If the context does not support an answer, say so plainly ${answerLang === "en" ? "in English" : "in Lao"} — never invent tax rates, amounts, or account codes.`,
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
    // Restated last, deliberately. Everything above is about Lao accounting and much of the
    // retrieved context is Lao, so the language instruction has to be the final thing read
    // or it loses to the surrounding pull. Repetition is the cheapest lever available on a
    // local 9B that does not reliably follow a single mid-prompt directive.
    answerLang === "en"
      ? "REMINDER: your entire answer must be in ENGLISH, even though the sources are in Lao."
      : answerLang === "both"
        ? "REMINDER: answer twice — the full Lao version under `## ລາວ`, then the full English version under `## English`."
        : "REMINDER: your entire answer must be in Lao (ພາສາລາວ).",
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
/**
 * The same budget in teaching mode, cut to make room for the answer.
 *
 * Both numbers are ceilings, and neither binds at the default k=8: `sourceCaps` caps each
 * source at 700 chars first, so eight sources are 5,600 chars — under both. At that size a
 * teaching answer already fits, and this constant does nothing.
 *
 * It exists for the top of the range. `k` is caller-controlled up to 20, and twenty sources
 * want 14,000 chars — over both budgets. There the arithmetic matters: SEA-LION v3 caps at
 * num_ctx 8192 and Ollama context-shifts the OLDEST tokens out on overflow, the system
 * prompt first. A teaching answer is two to three times longer than a normal one AND its
 * rules add to the system prompt, so leaving the ceiling at 10,000 chars would push the
 * total past the window and silently evict the very rules that make the mode work. The
 * failure would look like "teach mode does nothing", with no error anywhere.
 */
const TEACH_CONTEXT_CHAR_BUDGET = 6_000;
/** Floor per source when the budget forces scaling — below this a chunk is noise. */
const MIN_SOURCE_CHARS = 250;

/** Per-source char caps: the usual per-kind cap, scaled down proportionally when
 *  the sum would overflow the total budget (large k + web search stacked up). */
function sourceCaps(sources: CitationSource[], budget: number): number[] {
  const want = sources.map((s) =>
    Math.min(s.origin === "web" ? MAX_WEB_SOURCE_CHARS : MAX_SOURCE_CHARS, s.content.length),
  );
  const total = want.reduce((a, b) => a + b, 0);
  if (total <= budget) return want;
  const scale = budget / total;
  return want.map((w) => Math.max(MIN_SOURCE_CHARS, Math.floor(w * scale)));
}

/** Tokens to allow the answer, by mode. The teaching shape has six sections and a worked
 *  example; 1,024 truncates it mid-table, which is worse than not teaching at all. */
export const ANSWER_TOKENS = { normal: 1024, teach: 2400 } as const;

/** The context budget for a mode. Exported so the caller cannot drift from it. */
export const contextBudgetFor = (teach: boolean): number =>
  teach ? TEACH_CONTEXT_CHAR_BUDGET : CONTEXT_CHAR_BUDGET;

export function buildContext(sources: CitationSource[], teach = false): string {
  if (!sources.length) return "(no relevant documents found)";
  const caps = sourceCaps(sources, contextBudgetFor(teach));
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
  /** Language the answer must be in. Named again here, on the final line, for exactly the
   *  reason the comment above gives: the last thing read carries the most weight, and the
   *  system prompt alone did not win against a Lao persona plus Lao context. */
  answerLang: ResolvedAnswerLang = "lo",
  /** Teaching mode — shrinks the context budget and restates the shape on the last line. */
  teach = false,
): string {
  const context = buildContext(sources, teach);
  const hist = buildHistory(history);
  const parts: string[] = [];
  if (hist) parts.push(`[Conversation so far]\n${hist}`);
  parts.push(`[Retrieved context for the current question]\n${context}`);
  if (givenValues) parts.push(`[Given values]\n${givenValues}`);
  parts.push(`Question: ${question}`);
  const langLine =
    answerLang === "en"
      ? "Answer IN ENGLISH (cite [n], or state it is not in the documents). The sources are Lao; write your answer in English, keeping each Lao term in parentheses after its English rendering."
      : answerLang === "both"
        ? "Answer TWICE — `## ລາວ` then `## English` (cite [n] in both, or state it is not in the documents):"
        : "Answer in Lao (cite [n] or state it is not in the documents):";
  // The teaching shape restated on the last line, for the same reason the language is:
  // this is the final thing read, and it carries the most weight on a local 9B.
  parts.push(
    teach
      ? `TEACH this to a student, in the six sections (Short answer → Terms → How it works → Worked example → Common mistake → Try it). Explain from the sources; never invent a step to fill a section. ${langLine}`
      : langLine,
  );
  return parts.join("\n\n");
}
