import { describe, expect, it } from "bun:test";

import { applyGivenValues, extractGivenValues } from "../values.ts";

describe("applyGivenValues — calculation", () => {
  it("computes VAT deterministically and emits it as a citation", () => {
    const r = applyGivenValues({ amountLak: "5000000", rateBp: 1000, mode: "add" }, 3);
    expect(r.error).toBeNull();
    expect(r.sources).toHaveLength(1);
    const src = r.sources[0]!;
    // Numbered after the retrieved corpus, so [n] stays one sequence.
    expect(src.n).toBe(4);
    expect(src.origin).toBe("calc");
    expect(src.content).toContain("500,000");
    expect(src.content).toContain("5,500,000");
  });

  it("extracts VAT from a gross amount", () => {
    const r = applyGivenValues({ amountLak: "11000000", rateBp: 1000, mode: "extract" }, 0);
    expect(r.sources[0]?.content).toContain("10,000,000");
    expect(r.sources[0]?.content).toContain("1,000,000");
  });

  it("keeps full precision past the float boundary", () => {
    // 9,007,199,254,740,993 is the first integer a double cannot represent. Formatting via
    // Number would round it, undoing the BigInt arithmetic at the last step.
    const r = applyGivenValues({ amountLak: "9007199254740993", rateBp: 0, mode: "add" }, 0);
    expect(r.sources[0]?.content).toContain("9,007,199,254,740,993");
  });

  it("accepts a thousands-separated amount as typed", () => {
    const r = applyGivenValues({ amountLak: "5,000,000", rateBp: 1000, mode: "add" }, 0);
    expect(r.error).toBeNull();
    expect(r.sources[0]?.content).toContain("5,500,000");
  });

  it("defaults the mode to add rather than guessing from the amount", () => {
    const r = applyGivenValues({ amountLak: "1000", rateBp: 1000 }, 0);
    expect(r.sources[0]?.content).toContain("1,100");
  });
});

describe("applyGivenValues — refusals", () => {
  it("refuses to invent the missing half of a calculation", () => {
    // vatCalc's contract is that it never assumes a rate; this is that contract one layer up.
    const r = applyGivenValues({ amountLak: "5000000" }, 0);
    expect(r.sources).toHaveLength(0);
    expect(r.error).toContain("BOTH");
    expect(r.promptBlock).toContain("no calculation was run");
  });

  it("reports a malformed amount instead of throwing the turn away", () => {
    const r = applyGivenValues({ amountLak: "5000.50", rateBp: 1000 }, 0);
    expect(r.sources).toHaveLength(0);
    expect(r.error).toContain("integer");
    // The question still gets answered from the corpus.
    expect(r.promptBlock).not.toBe("");
  });

  it("returns nothing at all when no values were given", () => {
    const r = applyGivenValues({}, 0);
    expect(r.sources).toHaveLength(0);
    expect(r.promptBlock).toBe("");
    expect(r.error).toBeNull();
  });
});

describe("applyGivenValues — attributes", () => {
  it("states attributes as given facts without making them citations", () => {
    // An assertion by the user is not evidence: a citation is something a reviewer can
    // check against a source.
    const r = applyGivenValues({ attributes: [{ label: "ປະເພດທຸລະກິດ", value: "ໂຮງແຮມ" }] }, 0);
    expect(r.sources).toHaveLength(0);
    expect(r.promptBlock).toContain("ປະເພດທຸລະກິດ: ໂຮງແຮມ");
    expect(r.promptBlock).toContain("given facts");
  });

  it("drops blank rows and caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `k${i}`, value: `v${i}` }));
    const r = applyGivenValues({ attributes: [{ label: " ", value: " " }, ...many] }, 0);
    const lines = r.promptBlock.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(12);
  });

  it("tells the model not to alter a figure the user supplied", () => {
    const r = applyGivenValues({ amountLak: "5000000", rateBp: 1000 }, 0);
    expect(r.promptBlock).toContain("Never alter a figure the user provided");
    expect(r.promptBlock).toContain("do NOT recompute");
  });
});

describe("extractGivenValues — reading the question itself", () => {
  it("lifts an amount and a rate written in the sentence", () => {
    const v = extractGivenValues("ຄິດໄລ່ອາກອນ 5,000,000 ກີບ ອັດຕາ 10%");
    expect(v).toEqual({ amountLak: "5,000,000", rateBp: 1000, mode: "add" });
  });

  it("accepts LAK and kip as the currency marker", () => {
    expect(extractGivenValues("VAT on 5000000 LAK at 10%")?.rateBp).toBe(1000);
    expect(extractGivenValues("2,500,000 kip 7%")?.amountLak).toBe("2,500,000");
  });

  it("reads the Lao words for percent", () => {
    expect(extractGivenValues("1,000,000 ກີບ 10 ສ່ວນຮ້ອຍ")?.rateBp).toBe(1000);
    expect(extractGivenValues("1,000,000 ກີບ 7 ເປີເຊັນ")?.rateBp).toBe(700);
  });

  it("handles a fractional rate without letting a float reach the money", () => {
    expect(extractGivenValues("1,000,000 ກີບ 8.5%")?.rateBp).toBe(850);
    // Lao usage writes the decimal comma; it must not be read as a thousands separator.
    expect(extractGivenValues("1,000,000 ກີບ 8,5%")?.rateBp).toBe(850);
  });

  it("treats an inclusive amount as extract, and 'excluding' as add", () => {
    expect(extractGivenValues("11,000,000 ກີບ ລວມອາກອນ 10%")?.mode).toBe("extract");
    // ບໍ່ລວມ contains ລວມ and means the opposite — it has to win.
    expect(extractGivenValues("10,000,000 ກີບ ບໍ່ລວມອາກອນ 10%")?.mode).toBe("add");
  });

  it("does NOT fire on a question that merely contains numbers", () => {
    // The failure that would matter: a confident computed figure attached to a question
    // that never asked for one.
    expect(extractGivenValues("ບັນຊີຫຼັກແມ່ນ 411 ແລະ 701")).toBeUndefined();
    expect(extractGivenValues("ອັດຕາ VAT ຢູ່ລາວແມ່ນ 10% ບໍ?")).toBeUndefined();
    expect(extractGivenValues("ຂ້ອຍມີ 5,000,000 ກີບ")).toBeUndefined();
    expect(extractGivenValues("ອາກອນມູນຄ່າເພີ່ມແມ່ນຫຍັງ?")).toBeUndefined();
  });

  it("rejects an out-of-range rate rather than clamping it", () => {
    expect(extractGivenValues("1,000,000 ກີບ 150%")).toBeUndefined();
  });

  it("feeds straight into applyGivenValues", () => {
    const v = extractGivenValues("ຄິດໄລ່ອາກອນ 5,000,000 ກີບ 10%");
    const r = applyGivenValues(v!, 0);
    expect(r.error).toBeNull();
    expect(r.sources[0]?.content).toContain("5,500,000");
  });
});
