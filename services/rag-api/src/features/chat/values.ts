/**
 * User-supplied values for a question — "here is the amount, now work it out".
 *
 * Two different things arrive here and they are treated differently on purpose:
 *
 *   1. Values that drive a DETERMINISTIC calculator (amount + rate → VAT). The arithmetic
 *      is done in `vatCalc` with BigInt end-to-end, and the result becomes a citation. The
 *      generator never computes it. That is not a stylistic preference: LAK is integer-only
 *      (CLAUDE.md) and a language model doing money arithmetic is exactly how a rounded or
 *      transposed figure ends up in a ledger with a confident sentence around it.
 *
 *   2. Free-form labelled attributes ("ປະເພດທຸລະກິດ: ໂຮງແຮມ"). These are assertions by the
 *      user, not evidence, so they go into the prompt as given facts and do NOT become
 *      citations — a citation is something a reviewer can check against a source.
 *
 * A computed source is `origin: "calc"`: exact, but true only of the inputs it was given.
 * Like an ERP read it is point-in-time and the promote-to-dataset path excludes it.
 */
import { vatCalc } from "../tools/service.ts";
import type { CitationSource } from "./prompt.ts";

/* ── Reading values out of the question itself ───────────────────────────────────────
 *
 * There is one input box. Values are written in the sentence, the way anyone would ask —
 * "ຄິດໄລ່ອາກອນ 5,000,000 ກີບ ອັດຕາ 10%" — and lifted from it here. Same approach as
 * detectAndRunErpTools: deterministic patterns over the user's LITERAL message, never the
 * condensed rewrite, because a paraphrase that shifted a digit would compute a real answer
 * to the wrong question.
 *
 * The bar for firing is deliberately high — an amount carrying an explicit currency word
 * AND an explicit percentage. Both, or nothing. "ບັນຊີ 411 ແລະ 701" has numbers and no
 * calculation in it; "ອັດຕາ VAT ແມ່ນ 10%?" has a rate and nothing to apply it to. Neither
 * should silently produce a computed figure.
 */

/** A number with optional thousands separators, immediately followed by a currency word. */
const AMOUNT_WITH_CURRENCY = /(\d[\d,\u00A0 ]*?)\s*(?:\u0E81\u0EB5\u0E9A|kip|LAK)(?![A-Za-z0-9])/iu;
/** A percentage, written with % or the Lao word. */
const RATE = /(\d+(?:[.,]\d+)?)\s*(?:%|ສ່ວນຮ້ອຍ|ເປີເຊັນ)/u;

/** "ບໍ່ລວມ" (excluding) is checked first — it contains "ລວມ" and means the opposite. */
const NET_HINTS = ["ບໍ່ລວມ", "ຍັງບໍ່ລວມ", "ສຸດທິ", "net", "exclusive"];
const GROSS_HINTS = ["ລວມອາກອນ", "ລວມພາສີ", "ລວມ vat", "ລວມແລ້ວ", "gross", "inclusive"];

/**
 * Lift calculable values out of a question, or undefined when there are none.
 *
 * Returns only when BOTH an amount and a rate are present, so a stray number never
 * produces a citation. Unlike the explicit API path, a half-specified question is not an
 * error here — typing a number is not a request to compute.
 */
export function extractGivenValues(message: string): GivenValues | undefined {
  const amountMatch = AMOUNT_WITH_CURRENCY.exec(message);
  const rateMatch = RATE.exec(message);
  if (!amountMatch || !rateMatch) return undefined;

  const amountLak = (amountMatch[1] ?? "").replace(/[  ]/g, "");
  // A percent may be written 10,5 in Lao usage; normalise to a dot before parsing.
  const pct = Number((rateMatch[1] ?? "").replace(",", "."));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return undefined;
  if (!/^\d[\d,]*$/.test(amountLak)) return undefined;

  const lower = message.toLowerCase();
  const mode: "add" | "extract" = NET_HINTS.some((h) => lower.includes(h))
    ? "add"
    : GROSS_HINTS.some((h) => lower.includes(h))
      ? "extract"
      : "add";

  return { amountLak, rateBp: Math.round(pct * 100), mode };
}

export interface GivenValues {
  /** Integer LAK, as a STRING — JSON numbers are doubles and a large kip amount would
   *  lose precision before it ever reached the calculator. */
  amountLak?: string;
  /** VAT rate in basis points: 1000 = 10%. Integer, so no float rate creeps in. */
  rateBp?: number;
  /** "add" = the amount is net; "extract" = the amount already includes VAT. */
  mode?: "add" | "extract";
  /** Anything else the user wants the answer to take as given. */
  attributes?: { label: string; value: string }[];
}

export interface GivenValuesResult {
  sources: CitationSource[];
  /** Prompt block stating what the user supplied, or "" when nothing was given. */
  promptBlock: string;
  /** Human-readable reason a requested calculation could not run. */
  error: string | null;
}

/**
 * Thousands-separate an integer LAK string WITHOUT going through Number.
 *
 * `Number("9007199254740993").toLocaleString()` silently rounds — which would undo, at the
 * last step, the exact BigInt arithmetic this whole path exists to protect. The amount is
 * already a digit string; grouping it is string work.
 */
function groupLak(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const MAX_ATTRIBUTES = 12;
const MAX_LABEL = 60;
const MAX_VALUE = 200;

function cleanAttributes(input: GivenValues["attributes"]): { label: string; value: string }[] {
  return (input ?? [])
    .map((a) => ({
      label: a.label.trim().slice(0, MAX_LABEL),
      value: a.value.trim().slice(0, MAX_VALUE),
    }))
    .filter((a) => a.label !== "" && a.value !== "")
    .slice(0, MAX_ATTRIBUTES);
}

/**
 * Run whatever the supplied values support, and describe them for the prompt.
 *
 * Fails soft on a bad calculation input: the question still gets answered from the corpus,
 * with the reason stated, rather than the whole turn erroring out because a rate was typed
 * wrong. `vatCalc` validates its own inputs and throws — that message is what surfaces.
 */
export function applyGivenValues(values: GivenValues, startN: number): GivenValuesResult {
  const attributes = cleanAttributes(values.attributes);
  const sources: CitationSource[] = [];
  const lines: string[] = [];
  let error: string | null = null;

  const wantsVat = values.amountLak !== undefined && values.rateBp !== undefined;
  if (wantsVat) {
    try {
      const r = vatCalc({
        amountLak: values.amountLak as string,
        rateBp: values.rateBp as number,
        mode: values.mode ?? "add",
      });
      const pct = (r.rateBp / 100).toString();
      sources.push({
        n: startN + sources.length + 1,
        id: `calc:vat:${r.mode}:${r.rateBp}:${r.grossLak}`,
        content: [
          `ວິທີຄິດໄລ່: ${r.mode === "add" ? "ບວກອາກອນເຂົ້າຍອດສຸດທິ" : "ແຍກອາກອນອອກຈາກຍອດລວມ"}`,
          `ອັດຕາ: ${pct}%`,
          `ຍອດສຸດທິ (net): ${groupLak(r.netLak)} ກີບ`,
          `ອາກອນ (VAT): ${groupLak(r.vatLak)} ກີບ`,
          `ຍອດລວມ (gross): ${groupLak(r.grossLak)} ກີບ`,
          r.note,
        ].join("\n"),
        headingPath: [],
        kind: "calc",
        title: `ຄິດໄລ່ອາກອນມູນຄ່າເພີ່ມ ${pct}%`,
        authority: "Arnfar calculator (integer LAK, half-up)",
        effectiveDate: null,
        superseded: null,
        origin: "calc" as const,
        url: null,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else if (values.amountLak !== undefined || values.rateBp !== undefined) {
    // Half a calculation is not a calculation. Say so instead of assuming the missing half —
    // vatCalc's own contract is that it never invents a rate.
    error = "a VAT calculation needs BOTH an amount and a rate; neither is assumed";
  }

  if (values.amountLak !== undefined) {
    lines.push(`- ຈຳນວນເງິນ (amount): ${values.amountLak} ກີບ`);
  }
  if (values.rateBp !== undefined) {
    lines.push(`- ອັດຕາ (rate): ${(values.rateBp / 100).toString()}%`);
  }
  for (const a of attributes) lines.push(`- ${a.label}: ${a.value}`);

  const promptBlock = lines.length
    ? [
        "Values supplied by the user for THIS question — treat them as given facts, not as",
        "something to verify or change. Never alter a figure the user provided.",
        ...lines,
        sources.length
          ? "A calculator has already computed the result and it appears as a numbered source below. Quote its figures exactly and cite it; do NOT recompute the arithmetic yourself."
          : "",
        error
          ? `Note: no calculation was run — ${error}. Say so plainly rather than estimating.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return { sources, promptBlock, error };
}
