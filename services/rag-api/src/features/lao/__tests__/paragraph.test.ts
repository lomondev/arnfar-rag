import { describe, expect, it } from "bun:test";

import { createLaoJoiner, fixLaoTypography, looksSegmented, repairLaoAnswer } from "../clean.ts";

/** Real shapes, taken from this corpus and from the generator's own output. */
const SEGMENTED = "ອາກອນມູນຄ່າເພີ່ມ ແມ່ນ ອາກອນ ທາງອ້ອມ ທີ່ ເກັບ ຈາກ ມູນຄ່າເພີ່ມ ຂອງ ສິນຄ້າ ແລະ ບໍລິການ";
const WELL_WRITTEN =
  "ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມ ທີ່ເກັບຈາກມູນຄ່າເພີ່ມຂອງສິນຄ້າແລະບໍລິການ ໃນແຕ່ລະຂັ້ນຕອນຂອງການຜະລິດ";

describe("looksSegmented", () => {
  it("recognises segmenter output", () => {
    expect(looksSegmented(SEGMENTED)).toBe(true);
  });

  it("does not fire on Lao written normally", () => {
    // This is the gate that stops the joiner destroying real phrase spacing.
    expect(looksSegmented(WELL_WRITTEN)).toBe(false);
  });

  it("abstains when there is too little Lao to judge", () => {
    expect(looksSegmented("ບັນຊີ ຫຼັກ")).toBe(false);
    expect(looksSegmented("")).toBe(false);
    expect(looksSegmented("VAT is 10%")).toBe(false);
  });
});

describe("repairLaoAnswer", () => {
  it("repairs segmented text", () => {
    expect(repairLaoAnswer(SEGMENTED)).toBe(
      "ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມທີ່ເກັບຈາກມູນຄ່າເພີ່ມຂອງສິນຄ້າແລະບໍລິການ",
    );
  });

  it("leaves the phrase spacing of a well-written answer intact", () => {
    // The regression that matters: the joiner alone would fuse these three phrases into
    // one unreadable run.
    expect(repairLaoAnswer(WELL_WRITTEN)).toBe(WELL_WRITTEN);
  });
});

describe("fixLaoTypography", () => {
  it("closes up a space before a clause mark", () => {
    expect(fixLaoTypography("ຂາຍສິນຄ້າ , ຊື້ສິນຄ້າ")).toBe("ຂາຍສິນຄ້າ, ຊື້ສິນຄ້າ");
    expect(fixLaoTypography("ບັນຊີຫຼັກ .")).toBe("ບັນຊີຫຼັກ.");
  });

  it("opens a space after a clause mark between Lao words", () => {
    expect(fixLaoTypography("ຂາຍສິນຄ້າ,ຊື້ສິນຄ້າ")).toBe("ຂາຍສິນຄ້າ, ຊື້ສິນຄ້າ");
    expect(fixLaoTypography("ບັນຊີຫຼັກ.ຕໍ່ໄປ")).toBe("ບັນຊີຫຼັກ. ຕໍ່ໄປ");
  });

  it("NEVER breaks a thousands-separated LAK amount", () => {
    // CLAUDE.md: LAK is an integer, thousands-separated. Turning 1,000,000 into
    // "1, 000, 000" would corrupt every amount in the product.
    expect(fixLaoTypography("ຈຳນວນ 1,000,000 ກີບ")).toBe("ຈຳນວນ 1,000,000 ກີບ");
    expect(fixLaoTypography("ອັດຕາ 1.5 ສ່ວນຮ້ອຍ")).toBe("ອັດຕາ 1.5 ສ່ວນຮ້ອຍ");
  });

  it("leaves URLs and markdown keys alone", () => {
    expect(fixLaoTypography("https://example.la/a.html")).toBe("https://example.la/a.html");
    expect(fixLaoTypography("title: Cash Flow")).toBe("title: Cash Flow");
  });

  it("separates Lao from adjacent Latin or digits", () => {
    expect(fixLaoTypography("ບັນຊີ411")).toBe("ບັນຊີ 411");
    expect(fixLaoTypography("ອັດຕາ10%ຂອງ")).toBe("ອັດຕາ 10% ຂອງ");
    expect(fixLaoTypography("ອາກອນVAT")).toBe("ອາກອນ VAT");
  });

  it("binds the repetition mark ໆ to its word", () => {
    expect(fixLaoTypography("ຕ່າງ ໆ")).toBe("ຕ່າງໆ");
  });

  it("closes up an opening bracket and collapses doubled commas", () => {
    expect(fixLaoTypography("( ບັນຊີ)")).toBe("(ບັນຊີ)");
    expect(fixLaoTypography("ຂາຍ,,ຊື້")).toBe("ຂາຍ, ຊື້");
  });

  it("normalises paragraph spacing and trailing whitespace", () => {
    expect(fixLaoTypography("ຂໍ້ 1   \n\n\n\nຂໍ້ 2")).toBe("ຂໍ້ 1\n\nຂໍ້ 2");
  });

  it("adds and removes no punctuation of its own", () => {
    // The safety property the whole design rests on: marks in == marks out.
    const before = "ອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%, ເກັບຈາກສິນຄ້າ. ບັນຊີ 411 ແລະ 701";
    const marks = (s: string) => (s.match(/[,.;:!?()-]/g) ?? []).join("");
    expect(marks(fixLaoTypography(before))).toBe(marks(before));
  });

  it("is idempotent", () => {
    const once = fixLaoTypography("ຂາຍສິນຄ້າ ,ຊື້ສິນຄ້າ ບັນຊີ411");
    expect(fixLaoTypography(once)).toBe(once);
  });
});

describe("createLaoJoiner latches its verdict", () => {
  function streamed(text: string): string {
    const j = createLaoJoiner();
    let out = "";
    for (const ch of text) out += j.feed(ch);
    return out + j.flush();
  }

  it("streams a segmented answer to the same result as the whole-string repair", () => {
    expect(streamed(SEGMENTED)).toBe("ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມທີ່ເກັບຈາກມູນຄ່າເພີ່ມຂອງສິນຄ້າແລະບໍລິການ");
  });

  it("streams a well-written answer through untouched", () => {
    expect(streamed(WELL_WRITTEN)).toBe(WELL_WRITTEN);
  });

  it("emits a short answer verbatim rather than holding it forever", () => {
    // Below the evidence bar the verdict is never reached during feed; flush must still
    // release the text.
    expect(streamed("ບໍ່ມີຂໍ້ມູນ")).toBe("ບໍ່ມີຂໍ້ມູນ");
    expect(streamed("VAT 10%")).toBe("VAT 10%");
  });

  it("does not flip register part-way through an answer", () => {
    // A segmented opening followed by a joined tail must come out in one register, not two.
    const mixed = `${SEGMENTED} ${WELL_WRITTEN}`;
    expect(streamed(mixed)).toBe(streamedOnce(mixed));
  });
});

/** Same as `streamed`, in one chunk — the verdict must be identical either way. */
function streamedOnce(text: string): string {
  const j = createLaoJoiner();
  return j.feed(text) + j.flush();
}
