/**
 * Language detection and answer-language policy.
 *
 * Deterministic and script-based on purpose. Detection sits in front of every chat turn,
 * so an LLM call here would add latency to the critical path and — worse — introduce a
 * model opinion into something that has an exact answer: which script the user typed.
 *
 * Lao and Thai occupy adjacent Unicode blocks and look similar to a classifier trained on
 * neither. CLAUDE.md already fights Thai contamination in generated Lao, so the Thai block
 * is detected separately rather than folded into "not Lao".
 */

/** Lao block, U+0E80–U+0EFF. */
const LAO = /[຀-໿]/g;
/** Thai block, U+0E00–U+0E7F. Adjacent to Lao and a common contamination source. */
const THAI = /[฀-๿]/g;
/** Latin letters only — digits and punctuation are script-neutral and must not vote. */
const LATIN = /[A-Za-z]/g;

/** The script a piece of text is written in. */
export type Lang = "lo" | "en" | "mixed";

/** What the caller wants the answer written in.
 *  `auto` follows the question; `both` returns Lao and English side by side. */
export type AnswerLang = "auto" | "lo" | "en" | "both";

/** The resolved answer language — what the prompt is actually built for. */
export type ResolvedAnswerLang = "lo" | "en" | "both";

/** A script needs this share of the letters before it counts as the text's language.
 *  Below it the text is genuinely mixed and the caller decides. */
const DOMINANCE = 0.6;

export interface ScriptCounts {
  lao: number;
  thai: number;
  latin: number;
}

/** Raw per-script letter counts. Exported because the review and verification paths want
 *  the counts themselves, not just the verdict. */
export function scriptCounts(text: string): ScriptCounts {
  return {
    lao: text.match(LAO)?.length ?? 0,
    thai: text.match(THAI)?.length ?? 0,
    latin: text.match(LATIN)?.length ?? 0,
  };
}

/** True when Lao text carries Thai characters — always a defect. Lao and Thai are
 *  different languages, and a Thai glyph inside a Lao accounting answer is either a
 *  generator slip or a bad paste. */
export function containsThai(text: string): boolean {
  return scriptCounts(text).thai > 0;
}

/**
 * Which language a question is written in.
 *
 * Digits, punctuation and whitespace are excluded: "VAT 10%" is three Latin letters, and
 * an amount in Lao kip is mostly digits. Counting them would let a number decide the
 * language of the sentence around it.
 */
export function detectLanguage(text: string): Lang {
  const { lao, latin } = scriptCounts(text);
  const total = lao + latin;
  if (total === 0) return "mixed";
  if (lao / total >= DOMINANCE) return "lo";
  if (latin / total >= DOMINANCE) return "en";
  return "mixed";
}

/**
 * Resolve the language the answer must be written in.
 *
 * `auto` follows the question. A genuinely mixed question resolves to Lao: this is a Lao
 * accounting assistant, the corpus is Lao, and the accounting terminology a mixed question
 * borrows is English precisely because the Lao term is the one being asked about.
 */
export function resolveAnswerLang(requested: AnswerLang, question: string): ResolvedAnswerLang {
  if (requested !== "auto") return requested;
  const detected = detectLanguage(question);
  return detected === "en" ? "en" : "lo";
}

/**
 * The answer-language directive for the system prompt.
 *
 * The English and bilingual modes are written to stay inside CLAUDE.md's rule that Lao is
 * never machine-translated: the rule protects stored document text, and these instruct the
 * generator to keep every Lao term, figure and account code in Lao **alongside** its
 * English rendering rather than replacing it. An English answer that silently dropped the
 * Lao term would be exactly the substitution the rule forbids.
 */
export function answerLanguageRule(lang: ResolvedAnswerLang): string[] {
  switch (lang) {
    case "lo":
      return [
        "- Write the ENTIRE answer in Lao (ພາສາລາວ), in formal written register (ພາສາຂຽນທາງການ). Do not answer in English, Thai, or any other language, whatever language the sources are in.",
      ];
    case "en":
      return [
        "- Write the ENTIRE answer in English. The sources are Lao; render their meaning in English — do not reproduce whole Lao sentences as the answer.",
        "- Keep Lao alongside, never instead: the first time an accounting term, account name, document title or authority appears, give the English followed by the Lao in parentheses — value-added tax (ອາກອນມູນຄ່າເພີ່ມ). Never drop the Lao form.",
        "- Copy every number, rate, date and account code exactly as the source gives it. Amounts stay in Lao kip (LAK) as integers with thousands separators.",
      ];
    case "both":
      return [
        "- Answer TWICE, in full, with no information in one version that is missing from the other.",
        "- First the complete Lao answer under the heading `## ລາວ`, in formal written register (ພາສາຂຽນທາງການ).",
        "- Then the complete English answer under the heading `## English`.",
        "- Both versions carry the SAME [n] citations and the SAME figures. If the two would disagree on a number, you have made an error — re-read the sources.",
        "- In the English version, give each Lao term with its Lao form in parentheses the first time it appears.",
      ];
  }
}
