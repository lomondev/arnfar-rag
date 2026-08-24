import { describe, expect, test } from "bun:test";

import { fixLaoDefects, scanLaoDefects } from "../clean.ts";

/**
 * Lao text defects are invisible on screen and fatal to retrieval: a zero-width space
 * inside a word makes the segmenter emit two tokens, so the lexical index stores
 * something no query will ever match. These tests pin the three defect classes the
 * cleaner claims to handle, including the two cases it must deliberately leave alone.
 */

const ZWSP = "​";
const BOM = "﻿";

describe("scanLaoDefects", () => {
  test("finds zero-width characters", () => {
    const d = scanLaoDefects(`ບັນຊີ${ZWSP}ການເງິນ`);
    expect(d.zeroWidth).toBe(1);
    expect(d.total).toBeGreaterThan(0);
  });

  test("counts every zero-width variant", () => {
    const d = scanLaoDefects(`a${ZWSP}b‌c‍d${BOM}e`);
    expect(d.zeroWidth).toBe(4);
  });

  test("finds doubled tone marks", () => {
    // U+0EC8 twice on one consonant — renders identically to one, breaks tokenization.
    expect(scanLaoDefects("ກ່່າ").doubledMarks).toBe(1);
  });

  test("finds a space before a combining mark", () => {
    expect(scanLaoDefects("ກ ່າ").spaceBeforeMark).toBe(1);
  });

  test("reports clean text as clean", () => {
    const d = scanLaoDefects("ບັນຊີການເງິນ");
    expect(d.total).toBe(0);
    expect(d.samples).toEqual([]);
  });

  test("caps samples at three", () => {
    const d = scanLaoDefects(Array.from({ length: 20 }, () => `x${ZWSP}y`).join(""));
    expect(d.samples.length).toBeLessThanOrEqual(3);
  });
});

describe("fixLaoDefects", () => {
  test("strips zero-width characters", () => {
    expect(fixLaoDefects(`ບັນຊີ${ZWSP}ການເງິນ`)).toBe("ບັນຊີການເງິນ");
  });

  test("collapses a doubled tone mark to one", () => {
    expect(fixLaoDefects("ກ່່າ")).toBe("ກ່າ");
  });

  test("removes the space before a combining mark", () => {
    expect(fixLaoDefects("ກ ່າ")).toBe("ກ່າ");
  });

  test("leaves already-clean Lao untouched", () => {
    const clean = "ອາກອນມູນຄ່າເພີ່ມ";
    expect(fixLaoDefects(clean)).toBe(clean);
  });

  test("preserves a space before the spacing vowels AA and AM", () => {
    // U+0EB2 and U+0EB3 are spacing vowels, not combining marks — a space before them
    // can be a real word boundary, so the cleaner must not eat it.
    expect(fixLaoDefects("ຄຳ ານ")).toBe("ຄຳ ານ");
    expect(fixLaoDefects("ຄຳ ຳ")).toBe("ຄຳ ຳ");
  });

  test("is idempotent", () => {
    const dirty = `ບັນຊີ${ZWSP}ກ່່າ ${"່"}ານ`;
    const once = fixLaoDefects(dirty);
    expect(fixLaoDefects(once)).toBe(once);
  });

  test("leaves an empty string alone", () => {
    expect(fixLaoDefects("")).toBe("");
  });
});
