import { describe, expect, it } from "bun:test";

import { hasPipeTable, resolveAligns } from "../markdown";

describe("hasPipeTable", () => {
  it("detects a header followed by a divider", () => {
    expect(hasPipeTable("| ປະເພດ | ບັນຊີ |\n| --- | --- |\n| ຂາຍ | 411 |")).toBe(true);
  });

  it("detects a table further down a chunk, not just at the top", () => {
    const chunk = "ຕາຕະລາງ ອັດຕາ:\n\n| ລາຍການ | ອັດຕາ |\n| --- | ---: |\n| VAT | 10% |";
    expect(hasPipeTable(chunk)).toBe(true);
  });

  it("accepts the alignment forms markdown allows", () => {
    expect(hasPipeTable("| a | b |\n| :--- | ---: |\n| 1 | 2 |")).toBe(true);
    expect(hasPipeTable("| a | b |\n| :---: | :---: |\n| 1 | 2 |")).toBe(true);
  });

  it("rejects prose that merely contains pipes", () => {
    // A Lao sentence with a stray pipe is not a table, and rendering it as one would
    // mangle a source the reviewer is checking an answer against.
    expect(hasPipeTable("ບັນຊີ 411 | ລູກໜີ້ການຄ້າ")).toBe(false);
    expect(hasPipeTable("ບັນຊີຫຼັກ ແມ່ນ 411 ແລະ 701.")).toBe(false);
  });

  it("rejects a header with no divider under it", () => {
    expect(hasPipeTable("| a | b |\n| ຂາຍ | 411 |")).toBe(false);
  });

  it("rejects a divider with no header above it", () => {
    expect(hasPipeTable("| --- | --- |")).toBe(false);
  });

  it("handles empty and single-line input without throwing", () => {
    expect(hasPipeTable("")).toBe(false);
    expect(hasPipeTable("| a | b |")).toBe(false);
  });

  it("accepts a divider the generator elided with U+2026", () => {
    // Verbatim from rag_message. SEA-LION pads a divider to the width of the column above
    // it and then abbreviates its own padding. The previous whole-line character class had
    // no `…` in it, so a seventeen-row Lao journal-entry table rendered as pipe-separated
    // prose — and two of the three account tables in the database were affected.
    const real = [
      "| ລະຫັດ | ຊື່ບັນຊີ | ເດບິດ (ກີບ) | ເຄຣດິດ (ກີບ) |",
      "| :---------- | :--------------------------------------------- | :------… | :------… |",
      "| 613 | ຄ່າເຊົ່າ | 4,000,000 | 0 |",
    ].join("\n");
    expect(hasPipeTable(real)).toBe(true);
  });

  it("accepts three dots as elision too", () => {
    // A model that cannot type … types dots instead.
    expect(hasPipeTable("| a | b |\n| :---... | ---... |\n| 1 | 2 |")).toBe(true);
  });

  it("still rejects a divider row whose cells are words", () => {
    // The per-cell rule is STRICTER than the old character class here: tolerance lives
    // inside a cell, and no amount of it makes Lao text look like dashes.
    expect(hasPipeTable("| ບັນຊີ | ລະຫັດ |\n| ຂາຍ | 411 |\n| ຊື້ | 601 |")).toBe(false);
  });

  it("rejects a row of empty cells, which is not a divider", () => {
    expect(hasPipeTable("| a | b |\n|  |  |\n| 1 | 2 |")).toBe(false);
  });

  it("tolerates a ragged divider with a missing cell", () => {
    expect(hasPipeTable("| a | b |\n| --- |  |\n| 1 | 2 |")).toBe(true);
  });
});

describe("resolveAligns", () => {
  /** Four columns: code, Lao name, debit, credit — the shape of every account table here. */
  const ROWS = [
    ["613", "ຄ່າເຊົ່າ", "4,000,000", "0"],
    ["531", "ເງິນສົດໃນມື", "0", "4,000,000"],
    ["37", "ສິນຄ້າຊື້ມາເພື່ອຂາຍ", "9,000,000", "0"],
  ];

  it("right-aligns money when the divider declares :--- on every column", () => {
    // The generator's actual output: a template, not a decision. Honouring it left kip
    // amounts ragged, which is the one thing a column of figures exists to prevent.
    const declared = ["start", "start", "start", "start"] as const;
    expect(resolveAligns(declared, ROWS, 4)).toEqual(["start", "start", "end", "end"]);
  });

  it("leaves an account-code column reading from the start", () => {
    // 613 / 531 / 37 are all digits, but they are labels. Right-aligning variable-length
    // labels leaves them ragged on the side the eye scans down. The separator in a money
    // cell is what tells the two apart — CLAUDE.md requires amounts to carry one.
    expect(resolveAligns([null, null, null, null], ROWS, 4)[0]).toBe("start");
  });

  it("honours a divider that actually distinguishes columns", () => {
    // Varied alignment IS a decision — a hand-written table keeps what it asked for, even
    // where that means a left-aligned column of numbers.
    const declared = ["start", "center", "start", "end"] as const;
    expect(resolveAligns(declared, ROWS, 4)).toEqual(["start", "center", "start", "end"]);
  });

  it("honours a divider that singles out only some columns", () => {
    // Marking one column and leaving the rest bare is deliberate; the unmarked ones infer.
    const declared = [null, "center", null, null] as const;
    expect(resolveAligns(declared, ROWS, 4)).toEqual(["start", "center", "end", "end"]);
  });

  it("infers when nothing is declared", () => {
    expect(resolveAligns([null, null, null, null], ROWS, 4)).toEqual([
      "start",
      "start",
      "end",
      "end",
    ]);
  });

  it("does not right-align a column that merely starts with digits", () => {
    // Account codes are numeric-looking, but a mixed column is prose and reads from the
    // start. `columnIsNumeric` needs EVERY non-empty cell to be a quantity.
    const mixed = [
      ["411", "ລູກໜີ້"],
      ["ຫຼາຍ", "ເຈົ້າໜີ້"],
    ];
    expect(resolveAligns([null, null], mixed, 2)).toEqual(["start", "start"]);
  });

  it("needs more than one value before calling a column numeric", () => {
    // A single figure is not a column of figures — one row proves nothing about the rest.
    const one = [["613", "ຄ່າເຊົ່າ", "4,000,000", "0"]];
    expect(resolveAligns([null, null, null, null], one, 4)).toEqual([
      "start",
      "start",
      "start",
      "start",
    ]);
  });

  it("aligns Lao-digit quantities like Latin ones", () => {
    // ໐໑໒໓ are digits, and a thousands separator marks them as an amount just as it does
    // for Latin figures.
    const lao = [
      ["ອາກອນ", "໑,໐໐໐"],
      ["ພາສີ", "໒,໐໐໐"],
    ];
    expect(resolveAligns([null, null], lao, 2)).toEqual(["start", "end"]);
  });

  it("treats a bare-integer column as a code, not an amount", () => {
    const years = [
      ["ອາກອນ", "2024"],
      ["ພາສີ", "2025"],
    ];
    expect(resolveAligns([null, null], years, 2)).toEqual(["start", "start"]);
  });
});
