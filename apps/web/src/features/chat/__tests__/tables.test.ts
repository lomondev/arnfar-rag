import { describe, expect, it } from "bun:test";

import { hasPipeTable } from "../markdown";

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
});
