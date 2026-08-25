import { describe, expect, it } from "bun:test";

import { createLaoJoiner, joinLaoWordSpaces, looksSegmented } from "../clean.ts";

describe("joinLaoWordSpaces", () => {
  it("joins words separated by a single space", () => {
    // Segmenter output → Lao orthography.
    expect(joinLaoWordSpaces("ອາກອນ ແມ່ນ ອາກອນ ທາງອ້ອມ")).toBe("ອາກອນແມ່ນອາກອນທາງອ້ອມ");
  });

  it("joins a long run, not just the first pair", () => {
    // A single regex pass consumes the letter that would start the next match; the
    // fixed-point loop is what makes the whole run collapse.
    expect(joinLaoWordSpaces("ກ ຂ ຄ ງ ຈ")).toBe("ກຂຄງຈ");
  });

  it("keeps spaces around digits — account lists must not fuse", () => {
    expect(joinLaoWordSpaces("ບັນຊີ ຫຼັກ ແມ່ນ 411 ແລະ 701")).toBe("ບັນຊີຫຼັກແມ່ນ 411 ແລະ 701");
  });

  it("keeps spaces around Latin text", () => {
    expect(joinLaoWordSpaces("ອາກອນ VAT ແມ່ນ 10%")).toBe("ອາກອນ VAT ແມ່ນ 10%");
  });

  it("keeps the space after sentence punctuation", () => {
    expect(joinLaoWordSpaces("ບັນຊີ ຫຼັກ. ຕໍ່ ໄປ ແມ່ນ")).toBe("ບັນຊີຫຼັກ. ຕໍ່ໄປແມ່ນ");
  });

  it("preserves a deliberate phrase break instead of fusing it", () => {
    // Two or more spaces is an authored clause boundary — it collapses to one space and
    // is then off-limits to the joiner.
    expect(joinLaoWordSpaces("ຂາຍ ສິນຄ້າ  ຊື້ ສິນຄ້າ")).toBe("ຂາຍສິນຄ້າ ຊື້ສິນຄ້າ");
  });

  it("never crosses a newline", () => {
    expect(joinLaoWordSpaces("ອາກອນ ແມ່ນ\nບັນຊີ ຫຼັກ")).toBe("ອາກອນແມ່ນ\nບັນຊີຫຼັກ");
  });

  it("leaves markdown table structure intact", () => {
    expect(joinLaoWordSpaces("| ປະເພດ ລາຍການ | ບັນຊີ ຫຼັກ |")).toBe("| ປະເພດລາຍການ | ບັນຊີຫຼັກ |");
  });

  it("keeps the space in ສປປ ລາວ — an initialism, not a segmenter artefact", () => {
    expect(joinLaoWordSpaces("ຢູ່ ສປປ ລາວ")).toBe("ຢູ່ ສປປ ລາວ");
    expect(joinLaoWordSpaces("ນິຕິບຸກຄົນ ທີ່ ດຳເນີນ ທຸລະກິດ ຢູ່ ສປປ ລາວ.")).toBe(
      "ນິຕິບຸກຄົນທີ່ດຳເນີນທຸລະກິດຢູ່ ສປປ ລາວ.",
    );
  });

  it("restores the space when the generator ran the initialism together", () => {
    // gemma-3n-laos writes ສປປລາວ regardless of the prompt rule; the correct form is
    // deterministic for a closed list, so it is repaired rather than left wrong.
    expect(joinLaoWordSpaces("ໃນ ສປປລາວ")).toBe("ໃນ ສປປ ລາວ");
    // Fully fused into a preceding word, the initialism has no boundary to anchor on and
    // is deliberately left alone — splitting inside a Lao run risks cutting a real word.
    expect(joinLaoWordSpaces("ຢູ່ສປປລາວ")).toBe("ຢູ່ສປປລາວ");
  });

  it("does not protect a word that merely ends in the initialism's letters", () => {
    // ...ສປປ must be a standalone token, not a suffix, or a real word would keep a
    // spurious space after it.
    expect(joinLaoWordSpaces("ກສປປ ລາວ")).toBe("ກສປປລາວ");
  });

  it("is idempotent", () => {
    const once = joinLaoWordSpaces("ອາກອນ ແມ່ນ ອາກອນ ທາງອ້ອມ ແລະ 411");
    expect(joinLaoWordSpaces(once)).toBe(once);
  });

  it("leaves text with no Lao untouched", () => {
    expect(joinLaoWordSpaces("VAT is 10% on 411 and 701")).toBe("VAT is 10% on 411 and 701");
    expect(joinLaoWordSpaces("")).toBe("");
  });
});

describe("createLaoJoiner (streaming)", () => {
  /** Feed the text one character at a time — the worst case, and what SEA-LION actually
   *  does for Lao. */
  function streamed(text: string): string {
    const j = createLaoJoiner();
    let out = "";
    for (const ch of text) out += j.feed(ch);
    return out + j.flush();
  }

  /** The streaming contract, now that the joiner is gated: it must equal the whole-string
   *  transform *under the same segmentation verdict*. Text that does not read as segmenter
   *  output passes through untouched, streamed or not. */
  function expected(text: string): string {
    return looksSegmented(text) ? joinLaoWordSpaces(text) : text;
  }

  const CASES = [
    "ອາກອນ ແມ່ນ ອາກອນ ທາງອ້ອມ ທີ່ ເກັບ ຈາກ ມູນຄ່າເພີ່ມ",
    "ບັນຊີ ຫຼັກ ແມ່ນ 411 ແລະ 701.",
    "| ປະເພດ ລາຍການ | ບັນຊີ ຫຼັກ |\n| --- | --- |\n| ຂາຍ ສິນຄ້າ | 411 |",
    "ຂາຍ ສິນຄ້າ  ຊື້ ສິນຄ້າ",
    "ອາກອນ ແມ່ນ\nບັນຊີ ຫຼັກ",
    "ນິຕິບຸກຄົນ ທີ່ ດຳເນີນ ທຸລະກິດ ຢູ່ ສປປ ລາວ.",
    "",
  ];

  for (const [i, text] of CASES.entries()) {
    it(`character-by-character equals the whole-string transform (case ${i + 1})`, () => {
      expect(streamed(text)).toBe(expected(text));
    });
  }

  it("matches for arbitrary chunk boundaries, including a split mid-space-run", () => {
    const text = "ອາກອນ ແມ່ນ ອາກອນ  ທາງອ້ອມ ແລະ 411 ກີບ";
    for (let cut = 0; cut <= text.length; cut++) {
      const j = createLaoJoiner();
      const out = j.feed(text.slice(0, cut)) + j.feed(text.slice(cut)) + j.flush();
      expect(out).toBe(expected(text));
    }
  });

  it("emits nothing until the register verdict is settled, then releases on flush", () => {
    // One word is far below the evidence bar, so feed holds it and flush lets it go
    // verbatim — a short answer must never be swallowed.
    const j = createLaoJoiner();
    expect(j.feed("ອາກອນ ")).toBe("");
    expect(j.flush()).toBe("ອາກອນ ");
    expect(j.flush()).toBe("");
  });
});
