import { describe, expect, test } from "bun:test";

import { chunkBlocks, type SegBlock } from "../chunker.ts";

/**
 * The chunker decides what a citation points at, and two of its rules are load-bearing
 * enough that CLAUDE.md states them as invariants: a table is never split, and a chunk
 * never spans a heading boundary. Both are silent when broken — retrieval just gets
 * quietly worse — so they are asserted here rather than trusted.
 */

function block(partial: Partial<SegBlock> & Pick<SegBlock, "kind" | "text">): SegBlock {
  return {
    seg: partial.seg ?? partial.text,
    tokens: partial.tokens ?? partial.text.split(/\s+/).filter(Boolean).length,
    lang: partial.lang ?? "lo",
    headingPath: partial.headingPath ?? [],
    ...partial,
  };
}

describe("chunkBlocks", () => {
  test("merges prose under one heading into a single chunk", () => {
    const chunks = chunkBlocks([
      block({ kind: "prose", text: "a b c", tokens: 3, headingPath: ["ບົດທີ 1"] }),
      block({ kind: "prose", text: "d e f", tokens: 3, headingPath: ["ບົດທີ 1"] }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe("a b c\nd e f");
    expect(chunks[0]?.tokenCount).toBe(6);
  });

  test("never merges across a heading boundary", () => {
    const chunks = chunkBlocks([
      block({ kind: "prose", text: "under one", tokens: 2, headingPath: ["ບົດທີ 1"] }),
      block({ kind: "prose", text: "under two", tokens: 2, headingPath: ["ບົດທີ 2"] }),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingPath).toEqual(["ບົດທີ 1"]);
    expect(chunks[1]?.headingPath).toEqual(["ບົດທີ 2"]);
  });

  test("emits an over-long table whole rather than splitting it", () => {
    // 900 tokens against a 400-token budget. Splitting would sever rows from their
    // header, which is exactly the failure this rule exists to prevent.
    const chunks = chunkBlocks([block({ kind: "table", text: "| a | b |", tokens: 900 })], 400);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("table");
    expect(chunks[0]?.tokenCount).toBe(900);
  });

  test("keeps a table out of the surrounding prose chunk", () => {
    const chunks = chunkBlocks([
      block({ kind: "prose", text: "before", tokens: 1 }),
      block({ kind: "table", text: "| x |", tokens: 5 }),
      block({ kind: "prose", text: "after", tokens: 1 }),
    ]);
    expect(chunks.map((c) => c.kind)).toEqual(["prose", "table", "prose"]);
  });

  test("gives every account row its own chunk", () => {
    const chunks = chunkBlocks([
      block({ kind: "account_row", text: "1010 ເງິນສົດ", tokens: 3 }),
      block({ kind: "account_row", text: "1020 ເງິນຝາກ", tokens: 3 }),
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.kind === "account_row")).toBe(true);
  });

  test("splits prose that exceeds the budget and carries overlap", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      block({ kind: "prose", text: `p${i}`, tokens: 100, headingPath: ["h"] }),
    );
    const chunks = chunkBlocks(many, 400, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Overlap may push a chunk past the budget by design; it must not run away.
      expect(c.tokenCount).toBeLessThanOrEqual(400 + 100);
    }
  });

  test("assigns sequential seq numbers with no gaps", () => {
    const chunks = chunkBlocks([
      block({ kind: "prose", text: "a", tokens: 1, headingPath: ["x"] }),
      block({ kind: "table", text: "| t |", tokens: 2 }),
      block({ kind: "account_row", text: "1010", tokens: 1 }),
    ]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
  });

  test("drops heading blocks rather than emitting them as chunks", () => {
    const chunks = chunkBlocks([
      block({ kind: "heading", text: "ບົດທີ 1", level: 1, tokens: 2 }),
      block({ kind: "prose", text: "body", tokens: 1, headingPath: ["ບົດທີ 1"] }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("prose");
  });

  test("returns nothing for no blocks", () => {
    expect(chunkBlocks([])).toEqual([]);
  });
});
