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

/* Each of these is a single BMP code unit, and stripping them individually is the whole
 * point — ZWSP/ZWNJ/ZWJ/BOM are exactly the invisibles that corrupt Lao segmentation.
 * The rule guards against splitting multi-code-point graphemes, which these are not. */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: single-code-unit invisibles, see above.
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
  // biome-ignore lint/suspicious/noAssignInExpressions: the assign-and-test loop is the standard incremental-scan idiom; splitting it duplicates the advance.
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
  return text.replace(ZERO_WIDTH, "").replace(DOUBLED_MARK, "$1").replace(SPACE_BEFORE_MARK, "$1");
}

/**
 * Join the spurious word-separating spaces that make Lao read as a token list.
 *
 * Lao is written scriptio continua: words run together, and a space marks a phrase or
 * clause boundary — roughly where English uses a comma. Text with a space between every
 * word ("ອາກອນ ແມ່ນ ອາກອນ ທາງອ້ອມ ທີ່ ເກັບ ຈາກ") is segmenter output, not Lao orthography.
 * It reaches answers because the seeded corpus was authored that way and the generator
 * copies the register of its context.
 *
 * The rule is deliberately narrow: a SINGLE space with a Lao letter on both sides is a
 * word separator and is removed. Everything else is left alone, because everything else
 * carries meaning —
 *
 *   "411 ແລະ 701"   digit on one side   → kept (an account list must not fuse)
 *   "ບັນຊີ. ຕໍ່ໄປ"    punctuation before  → kept (sentence boundary)
 *   "| ປະເພດ |"      markdown structure  → kept (the table would collapse)
 *   two or more spaces                  → collapsed to one and NOT joined: a deliberate
 *                                         phrase break survives as a phrase break
 *   newlines                            → never crossed
 *
 * Idempotent. Applied to generated answers, never to `content` (CLAUDE.md: byte-for-byte).
 */
const LAO_LETTER = "\\u0E80-\\u0EFF";
const LAO_WORD_SPACE = new RegExp(`([${LAO_LETTER}]) ([${LAO_LETTER}])`, "g");
const LAO_PHRASE_GAP = new RegExp(`([${LAO_LETTER}])[ \\t]{2,}(?=[${LAO_LETTER}])`, "g");

/**
 * Initialisms that keep the space after them. Narrow and evidence-driven, not a general
 * abbreviation list.
 *
 * Lao writes initialisms as bare consonant runs with a real space before the word they
 * qualify — "ສປປ ລາວ" is the country's name and appears in the authority line of almost
 * every accounting and tax document this system will ever ingest. The word-space rule
 * cannot see the difference between that space and a segmenter artefact, so the exception
 * is stated. LaoNLP's dictionary is what surfaced it: ສປປ is not a word, and running
 * /lao/check on a joined answer flagged it immediately.
 *
 * Add to this only with the same evidence — a real document, and a checker that objects.
 */
const KEEP_SPACED = ["ສປປ", "ສ.ປ.ປ"];
const ALTS = KEEP_SPACED.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/** The space AFTER a standalone initialism. The leading `[^Lao]` is what makes it
 *  standalone — without it, a real word ending in those letters would keep a stray space. */
const PROTECT_TRAILING = new RegExp(`(^|[^${LAO_LETTER}])(${ALTS}) `, "g");
/** The space BEFORE one, matched after the trailing pass so the lookahead sees the
 *  sentinel already in place. */
const PROTECT_LEADING = new RegExp(` (${ALTS})(?![${LAO_LETTER}])`, "g");
/**
 * The same list used in reverse: put the space BACK when it is missing.
 *
 * Protection alone is not enough, because it can only preserve a space the generator
 * actually wrote. gemma-3n-laos does not follow the "initialisms keep their spaces" prompt
 * rule and emits ສປປລາວ directly, so the country's name would still be wrong however
 * carefully the joiner behaved. The correct form is deterministic for a closed list, so it
 * is restored rather than left to the model.
 */
const RESTORE_SPACE = new RegExp(`(^|[^${LAO_LETTER}])(${ALTS})(?=[${LAO_LETTER}])`, "g");
/** U+E000, a Private Use Area code point: it cannot occur in Lao text, so standing in for
 *  a protected space is unambiguous and the restore below is exact. */
const SPACE_SENTINEL = "\uE000";

/** Space missing BEFORE a protected initialism, i.e. it is glued to the previous word. */
const GLUED_LEADING = new RegExp(`([${LAO_LETTER}])(${ALTS})(?=[${LAO_LETTER}]|$)`, "g");
/** Space missing AFTER one — the ສປປລາວ case. */
const GLUED_TRAILING = new RegExp(`(^|[^${LAO_LETTER}])(${ALTS})(?=[${LAO_LETTER}])`, "g");

/**
 * Put the spaces back around a protected initialism written without them.
 *
 * Exposed separately from the joiner's own RESTORE_SPACE because the defect appears
 * wherever a model writes Lao, not only on the de-segmenting path: the lesson drafter
 * emitted `ຢູ່ສປປລາວ` despite being given the explicit rule — the initialism glued to BOTH
 * neighbours. RESTORE_SPACE only handles a missing trailing space, because inside
 * joinLaoWordSpaces the leading one has already been parked on a sentinel.
 *
 * Inserting a space before an initialism that follows a Lao letter is safe **for this
 * closed list specifically**: every entry is a bare consonant run carrying no vowel, and
 * Lao orthography does not build words that way — so the sequence cannot be the middle of
 * a real word. That argument does not generalise, which is why the list stays closed and
 * every addition needs the same evidence the existing entries have.
 *
 * Idempotent: a correctly spaced initialism has a space where the lookahead demands a
 * letter, so neither pattern matches it.
 */
export function restoreInitialismSpacing(text: string): string {
  return text.replace(GLUED_LEADING, "$1 $2").replace(GLUED_TRAILING, "$1$2 ");
}

export function joinLaoWordSpaces(text: string): string {
  // Park protected spaces on a code point the joiner cannot match; restored at the end.
  let out = text
    // Restore first, while the boundary before the initialism still exists — after the
    // join "ໃນ ສປປລາວ" is one Lao run and there is nothing left to anchor on.
    .replace(RESTORE_SPACE, "$1$2 ")
    .replace(PROTECT_TRAILING, `$1$2${SPACE_SENTINEL}`)
    .replace(PROTECT_LEADING, `${SPACE_SENTINEL}$1`);
  // Word-join, and only ever on a single space. A run of two or more spaces cannot match
  // this pattern — that immunity is what protects an authored phrase break, and it only
  // holds while the run is intact, which is why gaps are collapsed afterwards rather than
  // before: collapsing first would hand the joiner a single space to eat.
  //
  // Loop to a fixed point: one pass consumes the letter that would start the next match,
  // so "ກ ຂ ຄ" would otherwise only join the first pair.
  let previous: string;
  do {
    previous = out;
    out = out.replace(LAO_WORD_SPACE, "$1$2");
  } while (out !== previous);
  // Now that the joiner has run, surviving multi-space runs are phrase breaks. Normalise
  // them to the single space Lao actually uses.
  return out.replace(LAO_PHRASE_GAP, "$1 ").replaceAll(SPACE_SENTINEL, " ");
}

/**
 * Is this text segmenter output rather than Lao written normally?
 *
 * This gate is what keeps {@link joinLaoWordSpaces} from doing harm. The joiner cannot tell
 * a spurious word separator from a real phrase break — both are one space between two Lao
 * letters — so running it unconditionally would fuse the clause spacing of an answer that
 * was already written correctly, which is the opposite of the goal.
 *
 * The two registers separate cleanly on run length, measured on this corpus:
 *
 *   seed corpus, segmented        median run 5,  67% of runs ≤ 6 chars
 *   template body, segmented      median run 5,  89% ≤ 6
 *   frontmatter title, joined     median run 20,  0% ≤ 6
 *   Lao written normally          median run 32,  0% ≤ 6
 *
 * A Lao word is 2–6 characters and a phrase is 15–40, so the gap is an order of magnitude
 * and the threshold is not delicate. Both conditions must hold: a short sample of genuinely
 * short words should not trip it.
 */
const LAO_RUN = /[຀-໿]+/g;
const SEGMENTED_MEDIAN_RUN = 8;
const SEGMENTED_SHORT_SHARE = 0.5;
/** Below this many Lao runs there is not enough evidence to call it either way. */
const MIN_RUNS_FOR_VERDICT = 6;

export function looksSegmented(text: string): boolean {
  const lengths = (text.match(LAO_RUN) ?? []).map((r) => [...r].length).sort((a, b) => a - b);
  if (lengths.length < MIN_RUNS_FOR_VERDICT) return false;
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const shortShare = lengths.filter((l) => l <= 6).length / lengths.length;
  return median <= SEGMENTED_MEDIAN_RUN && shortShare >= SEGMENTED_SHORT_SHARE;
}

/* ── Typography ──────────────────────────────────────────────────────────────────────
 *
 * Everything below is presentation, not meaning: where a mark already is, it stays; only
 * the whitespace around it is normalised. Nothing here inserts or removes a comma, a full
 * stop or a clause — see the note on repairLaoAnswer for why that line is drawn here.
 *
 * Every rule is anchored on a Lao letter. That is deliberate: an unanchored "space after a
 * colon" rule breaks `http://`, and an unanchored "space after a comma" rule turns the LAK
 * amount 1,000,000 into 1, 000, 000, which CLAUDE.md forbids outright.
 */
const L = "\\u0E80-\\u0EFF";
/** ໆ (U+0EC6) repeats the preceding word and binds to it like a suffix. */
const REPEAT_MARK_SPACE = new RegExp(`([${L}])[ \\t]+(\\u0EC6)`, "g");
/** No space before a mark that closes a clause. */
const SPACE_BEFORE_PUNCT = new RegExp(`([${L}])[ \\t]+([,.;:!?)])`, "g");
/** One space after a clause mark — only between Lao letters, so 1,000,000 and 1.5 are
 *  untouched, as are URLs and markdown keys. */
const PUNCT_NO_SPACE = new RegExp(`([${L}][,.;:!?])(?=[${L}])`, "g");
/** No space after an opening bracket. */
const SPACE_AFTER_OPEN = new RegExp(`([(\\[])[ \\t]+(?=[${L}])`, "g");
/** A Lao letter butted against Latin or a digit, in either direction. */
const LAO_THEN_ASCII = new RegExp(`([${L}])(?=[0-9A-Za-z])`, "g");
const ASCII_THEN_LAO = new RegExp(`([0-9A-Za-z%])(?=[${L}])`, "g");
const DOUBLED_COMMA = /,{2,}/g;
const TRAILING_WS = /[ \t]+$/gm;
const EXTRA_BLANK_LINES = /\n{3,}/g;

/**
 * Normalise the whitespace around punctuation that is already there.
 *
 * Safe by construction: no mark is added or deleted, so the sentence structure the
 * generator committed to is exactly the structure that reaches the reader.
 */
export function fixLaoTypography(text: string): string {
  return text
    .replace(REPEAT_MARK_SPACE, "$1$2")
    .replace(SPACE_BEFORE_PUNCT, "$1$2")
    .replace(DOUBLED_COMMA, ",")
    .replace(PUNCT_NO_SPACE, "$1 ")
    .replace(SPACE_AFTER_OPEN, "$1")
    .replace(LAO_THEN_ASCII, "$1 ")
    .replace(ASCII_THEN_LAO, "$1 ")
    .replace(TRAILING_WS, "")
    .replace(EXTRA_BLANK_LINES, "\n\n");
}

/**
 * The whole answer repair, in the order the pieces depend on each other.
 *
 * What this does NOT do, deliberately: insert commas, full stops or dashes to break a run-on
 * into clauses. That requires knowing which constituent a qualifier attaches to, and in this
 * domain the attachment IS the rule —
 *
 *   ອາກອນເກັບຈາກກຳໄລສຸດທິຂອງນິຕິບຸກຄົນທີ່ດຳເນີນທຸລະກິດຢູ່ ສປປ ລາວ
 *
 * A comma before ທີ່ makes "operating in Laos" describe the legal entity; a comma after it
 * makes it describe the profit. Those are different tax rules. LaoNLP is a tokeniser and a
 * word list — it has no parser and no POS tags, so it cannot make that call, and a regex
 * certainly cannot. Guessing would produce confident, well-punctuated, wrong law.
 *
 * Clause punctuation is therefore the generator's job, grounded in the retrieved sources,
 * and the prompt states the Lao paragraph conventions explicitly. What arrives here is
 * tidied, never reinterpreted.
 */
export function repairLaoAnswer(text: string): string {
  return fixLaoTypography(looksSegmented(text) ? joinLaoWordSpaces(text) : text);
}

/**
 * Streaming-safe wrapper around {@link joinLaoWordSpaces}.
 *
 * A join decision needs the character on BOTH sides of a space, and the generator emits
 * Lao at character granularity — the space and the letter after it routinely land in
 * different chunks. So the tail that is still undecidable (a trailing whitespace run plus
 * the character before it) is held back until the next chunk resolves it.
 *
 * `feed` returns text safe to emit; `flush` returns whatever is still held at end of
 * stream. Every feed concatenated with the flush equals joinLaoWordSpaces(wholeAnswer).
 */
/**
 * Characters of non-Lao output after which the register question is settled as "not Lao".
 *
 * Without this the joiner holds every token until six Lao runs arrive — which for an
 * English answer is never, so the whole answer lands in one lump at `flush()` and the user
 * watches an empty "writing" state until generation ends. Six runs is the right bar for
 * *judging Lao spacing*; it is the wrong bar for *deciding there is no Lao to judge*.
 *
 * Set well above a Lao answer's opening latency: an answer that starts with a heading or a
 * figure before its first Lao word must not be misjudged as English.
 */
const NON_LAO_CHARS_FOR_VERDICT = 120;

export interface LaoJoinerOptions {
  /**
   * Whether Lao is expected in this answer at all.
   *
   * `false` puts the joiner in pass-through immediately, so an English answer streams from
   * its first token. The caller knows this before generation starts — the answer language
   * is resolved deterministically in features/lao/lang.ts — so there is no reason to make
   * the joiner rediscover it from the output.
   */
  expectLao?: boolean;
}

export function createLaoJoiner(opts: LaoJoinerOptions = {}): {
  feed: (chunk: string) => string;
  flush: () => string;
} {
  // Re-join the whole answer each chunk and emit only the part not sent yet.
  //
  // The obvious cheaper design — carry one character of left context — cannot see a
  // multi-character protected token: by the time the space after "ສປປ" is decided, only
  // "ປ" is left in hand and the initialism is invisible. Keeping the full raw text is what
  // makes every rule above work identically streamed and unstreamed.
  //
  // Safe because the emitted prefix can never change retroactively: joining only ever
  // DELETES spaces (letters are untouched), and a trailing space is never emitted — it is
  // held until the character that decides it arrives. Answers are a few KB, so re-joining
  // per chunk is not worth optimising away.
  let raw = "";
  let emitted = 0;

  /**
   * Where the still-undecided tail begins.
   *
   * Two things are undecided at a chunk boundary:
   *  1. a trailing run of spaces — whether it survives depends on the next character;
   *  2. a trailing *partial* protected initialism preceded by a space. "ຢູ່ ສ" looks like
   *     an ordinary word space and joins; three characters later it is "ຢູ່ ສປປ " and the
   *     space must come back. Emitting early there duplicated a letter, because the
   *     emitted prefix is only stable if a space can never be re-inserted into it.
   */
  function undecidedFrom(s: string): number {
    const ws = /[ \t]+$/.exec(s);
    let i = ws ? ws.index : s.length;
    const maxLen = Math.max(...KEEP_SPACED.map((tok) => tok.length));
    for (let len = Math.min(maxLen, i); len >= 1; len--) {
      const candidate = s.slice(i - len, i);
      if (!KEEP_SPACED.some((tok) => tok.startsWith(candidate))) continue;
      const precededBySpace = i - len === 0 || s[i - len - 1] === " ";
      // Held back whether or not a space precedes it, because BOTH directions are now
      // undecided at this point: a space that is there may need removing (protection), and
      // a space that is missing may need inserting (restore — `ຢູ່ສປປລາວ`). Insertion is
      // the reason the no-space case matters: emitting `ຢູ່ສປປ` and then deciding the text
      // should read `ຢູ່ ສປປ ລາວ` would rewrite a prefix already on the reader's screen,
      // which is exactly what this function exists to prevent.
      //
      // When a space precedes, the cut includes it — the space itself is the undecided
      // character. When none does, the cut starts at the candidate.
      i = precededBySpace ? Math.max(0, i - len - 1) : i - len;
      break;
    }
    return i;
  }

  /**
   * The segmentation verdict, decided ONCE and then latched.
   *
   * It has to be latched because emitted text cannot be recalled: if the first line reads as
   * segmented and the fifth does not, flipping mid-answer would leave two incompatible
   * registers in one paragraph. Nothing is emitted until there is enough Lao to judge, or
   * the stream ends — a short delay on first paint, in exchange for a consistent answer.
   */
  // An answer that will not contain Lao has nothing to re-space: latch pass-through up
  // front so it streams from the first token instead of buffering to flush().
  let verdict: boolean | null = opts.expectLao === false ? false : null;

  function settled(): boolean {
    if (verdict !== null) return true;
    const runs = raw.match(LAO_RUN) ?? [];
    if (runs.length >= MIN_RUNS_FOR_VERDICT) {
      verdict = looksSegmented(raw);
      return true;
    }
    // Enough output has arrived with too little Lao in it to ever judge the spacing.
    // Settle as pass-through rather than holding the answer hostage to Lao that is not
    // coming — the caller may have asked for English, or the model may have ignored the
    // instruction, and either way the text must reach the reader.
    if (raw.length >= NON_LAO_CHARS_FOR_VERDICT) {
      verdict = false;
      return true;
    }
    return false;
  }

  /**
   * Everything decided so far.
   *
   * The cut is found in the RAW buffer, not the joined text — in the joined text the space
   * that signals a protected initialism has already been removed, so the tail no longer
   * looks undecided. Cutting first and joining the prefix is equivalent to joining the
   * whole and slicing, precisely because the cut is placed where no rule spans it.
   */
  function transform(s: string): string {
    // The verdict governs whether to JOIN word spaces. Restoring a protected initialism's
    // space is correct either way — `ສປປລາວ` is wrong in segmented and unsegmented Lao
    // alike — and `joinLaoWordSpaces` already restores it on its own path. Without this
    // branch the repair reached only text the model happened to write space-segmented,
    // which is the register it uses least.
    return verdict === true ? joinLaoWordSpaces(s) : restoreInitialismSpacing(s);
  }

  function decided(): string {
    return transform(raw.slice(0, undecidedFrom(raw)));
  }

  return {
    feed(chunk: string): string {
      if (chunk === "") return "";
      raw += chunk;
      // Hold everything until there is enough Lao to judge the register.
      if (!settled()) return "";
      const out = decided();
      if (out.length <= emitted) return "";
      const emit = out.slice(emitted);
      emitted = out.length;
      return emit;
    },
    flush(): string {
      // End of stream: judge on whatever arrived, even if it is below the evidence bar —
      // a two-word answer is emitted as written rather than held forever.
      if (verdict === null) verdict = looksSegmented(raw);
      // A trailing space here has no right-hand neighbour, so it stands.
      const rest = transform(raw).slice(emitted);
      raw = "";
      emitted = 0;
      verdict = opts.expectLao === false ? false : null;
      return rest;
    },
  };
}
