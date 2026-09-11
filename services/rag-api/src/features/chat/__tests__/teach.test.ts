import { describe, expect, test } from "bun:test";

import {
  ANSWER_TOKENS,
  buildContext,
  buildPrompt,
  buildSystemPrompt,
  type CitationSource,
  contextBudgetFor,
  TEACHING_RULES,
} from "../prompt.ts";

/**
 * Teaching mode.
 *
 * Two things are worth pinning. The first is that the mode is actually reachable: the rules
 * only work if they survive into the prompt and are restated where the model reads them
 * last. The second is the arithmetic — a longer answer inside a fixed 8192-token window
 * means the context must shrink, and getting that backwards evicts the teaching rules
 * themselves with no error anywhere.
 */

const source = (n: number, content: string): CitationSource => ({
  n,
  id: `chunk-${n}`,
  content,
  headingPath: [],
  kind: "prose",
  title: "ເອກະສານ",
  authority: null,
  effectiveDate: null,
  superseded: null,
  origin: "dataset",
  url: null,
});

describe("teaching mode changes the persona", () => {
  const base = { glossary: [], forbidden: [] };

  test("the rules are absent by default", () => {
    const normal = buildSystemPrompt(base);
    expect(normal).not.toContain("TEACHING MODE");
  });

  test("the rules are present when asked for", () => {
    const teaching = buildSystemPrompt({ ...base, teach: true });
    expect(teaching).toContain("TEACHING MODE");
    for (const rule of TEACHING_RULES) expect(teaching).toContain(rule);
  });

  test("cite-or-abstain survives teaching mode", () => {
    // The whole risk of a longer answer is that depth gets bought with invention. The
    // citation rule must still be there, and the teaching rules must say so themselves.
    const teaching = buildSystemPrompt({ ...base, teach: true });
    expect(teaching).toContain("Cite or abstain");
    expect(teaching).toMatch(/never from adding facts they do not contain/i);
  });

  test("teaching does not override the answer language", () => {
    const teaching = buildSystemPrompt({ ...base, teach: true, answerLang: "en" });
    expect(teaching).toContain("TEACHING MODE");
    expect(teaching).toContain("REMINDER: your entire answer must be in ENGLISH");
  });
});

describe("the teaching shape is restated last", () => {
  const sources = [source(1, "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.")];

  test("the final line asks for the six sections", () => {
    const prompt = buildPrompt("ອາກອນມູນຄ່າເພີ່ມແມ່ນຫຍັງ?", sources, [], "", "lo", true);
    const lastLine = prompt.trimEnd().split("\n").at(-1) ?? "";
    // Last thing read carries the most weight on a local 9B — the same reason the answer
    // language is restated there.
    expect(lastLine).toContain("TEACH");
    expect(lastLine).toContain("Worked example");
  });

  test("the normal final line is unchanged", () => {
    const prompt = buildPrompt("ອາກອນມູນຄ່າເພີ່ມແມ່ນຫຍັງ?", sources, [], "", "lo", false);
    const lastLine = prompt.trimEnd().split("\n").at(-1) ?? "";
    expect(lastLine).not.toContain("TEACH");
    expect(lastLine).toContain("Answer in Lao");
  });

  test("the language instruction survives on the teaching line", () => {
    const prompt = buildPrompt("What is VAT?", sources, [], "", "en", true);
    const lastLine = prompt.trimEnd().split("\n").at(-1) ?? "";
    expect(lastLine).toContain("TEACH");
    expect(lastLine).toContain("IN ENGLISH");
  });
});

describe("the window budget", () => {
  test("teaching buys answer tokens by spending context", () => {
    // The trade that keeps the total inside num_ctx=8192. If context did NOT shrink, the
    // longer answer would push the prompt past the window and Ollama would evict its head
    // — the teaching rules — silently.
    expect(ANSWER_TOKENS.teach).toBeGreaterThan(ANSWER_TOKENS.normal);
    expect(contextBudgetFor(true)).toBeLessThan(contextBudgetFor(false));
  });

  test("the budgets do not bind at the default k, and need not", () => {
    // Eight sources capped at 700 chars each is 5,600 — under both ceilings. A teaching
    // answer already fits there, so the two modes produce the same context.
    const eight = Array.from({ length: 8 }, (_, i) => source(i + 1, "ກ".repeat(900)));
    expect(buildContext(eight, true).length).toBe(buildContext(eight, false).length);
  });

  test("the teaching context shrinks at the top of the k range", () => {
    // k is caller-controlled up to 20, and twenty sources want 14,000 chars — over both
    // ceilings. This is where the trade actually happens.
    const twenty = Array.from({ length: 20 }, (_, i) => source(i + 1, "ກ".repeat(900)));
    expect(buildContext(twenty, true).length).toBeLessThan(buildContext(twenty, false).length);
  });

  test("a rough token estimate of the teaching prompt stays under the window", () => {
    // Lao runs ≈2 chars/token on Gemma2 (lib/env.ts). This is a guard rail, not a
    // tokenizer: it fails loudly if someone raises a budget without doing the arithmetic.
    const many = Array.from({ length: 8 }, (_, i) => source(i + 1, "ກ".repeat(900)));
    const system = buildSystemPrompt({ glossary: [], forbidden: [], teach: true });
    const prompt = buildPrompt("ຄຳຖາມ", many, [], "", "lo", true);
    const estTokens = (system.length + prompt.length) / 2 + ANSWER_TOKENS.teach;
    expect(estTokens).toBeLessThan(8192);
  });
});
