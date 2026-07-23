/**
 * Lao-aware text cleaning — whitelist-based, never generic.
 *
 * Generic "remove special characters / OCR noise" filters destroy Lao: vowels and tone
 * marks ARE combining characters. The only safe fixes are the specific defect classes we
 * have actually measured in real corpora (each one silently degrades retrieval):
 *
 *   1. zero-width junk        U+200B/200C/200D/FEFF injected by Word/OCR
 *   2. doubled combining mark ທີີ່ = ທ + ີ + ີ + ່ — no Lao word doubles the SAME mark
 *   3. space before a mark    "ທ ີ່" — a syllable broken by an injected space
 *
 * These are applied to content_norm (dense-embedding input) and to the text that feeds
 * segmentation (content_seg, the lexical index). The original `content` is NEVER touched
 * (CLAUDE.md: byte-for-byte, human edits only).
 *
 * COMBINING covers only true combining marks: MAI KAN (0EB1), vowels above/below
 * (0EB4–0EB9), MAI KON (0EBB), SEMI LO (0EBC), tones + cancellation (0EC8–0ECD).
 * Spacing vowels AA (0EB2) and AM (0EB3) are deliberately excluded — a space before
 * them can be a legitimate word boundary.
 */

const ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/g;
const COMBINING = "ັິ-ູົຼ່-ໍ";
const DOUBLED_MARK = new RegExp(`([${COMBINING}])\\1+`, "g");
const SPACE_BEFORE_MARK = new RegExp(`[ \\t]+([${COMBINING}])`, "g");

export interface LaoDefects {
  zeroWidth: number;
  doubledMarks: number;
  spaceBeforeMark: number;
  total: number;
  /** Up to 3 short snippets around defects, for the review UI. */
  samples: string[];
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

function snippetsAround(text: string, re: RegExp, max: number): string[] {
  const out: string[] = [];
  const global = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while (out.length < max && (m = global.exec(text)) !== null) {
    const start = Math.max(0, m.index - 12);
    out.push(text.slice(start, Math.min(text.length, m.index + m[0].length + 12)));
  }
  return out;
}

/** Count the defect classes without changing anything. */
export function scanLaoDefects(text: string): LaoDefects {
  const zeroWidth = countMatches(text, ZERO_WIDTH);
  const doubledMarks = countMatches(text, DOUBLED_MARK);
  const spaceBeforeMark = countMatches(text, SPACE_BEFORE_MARK);
  const samples =
    doubledMarks + spaceBeforeMark > 0
      ? [
          ...snippetsAround(text, DOUBLED_MARK, 2),
          ...snippetsAround(text, SPACE_BEFORE_MARK, 1),
        ].slice(0, 3)
      : [];
  return {
    zeroWidth,
    doubledMarks,
    spaceBeforeMark,
    total: zeroWidth + doubledMarks + spaceBeforeMark,
    samples,
  };
}

/** Apply the three whitelisted fixes. Idempotent. */
export function fixLaoDefects(text: string): string {
  return text
    .replace(ZERO_WIDTH, "")
    .replace(DOUBLED_MARK, "$1")
    .replace(SPACE_BEFORE_MARK, "$1");
}
