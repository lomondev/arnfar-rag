import { describe, expect, test } from "bun:test";

import { createLaoJoiner, restoreInitialismSpacing } from "../clean.ts";
import {
  answerLanguageRule,
  containsThai,
  detectLanguage,
  resolveAnswerLang,
  scriptCounts,
} from "../lang.ts";

describe("detectLanguage", () => {
  test("pure Lao is lo", () => {
    expect(detectLanguage("ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນເທົ່າໃດ")).toBe("lo");
  });

  test("pure English is en", () => {
    expect(detectLanguage("What is the value-added tax rate?")).toBe("en");
  });

  test("a Lao question borrowing one English term stays lo", () => {
    // The reason mixed-script questions must not flip language: users write the English
    // acronym precisely because the Lao term is what they are asking about.
    expect(detectLanguage("VAT ແມ່ນຫຍັງ ແລະ ຄິດໄລ່ແນວໃດ")).toBe("lo");
  });

  test("digits and punctuation do not vote", () => {
    // "10%" and "2026" are script-neutral; counting them would let a number decide the
    // language of the sentence around it.
    expect(detectLanguage("ອາກອນ 10% ໃນປີ 2026")).toBe("lo");
    expect(detectLanguage("VAT 10% in 2026, per §4.")).toBe("en");
  });

  test("text with no letters at all is mixed, not a crash", () => {
    expect(detectLanguage("123 456 %")).toBe("mixed");
    expect(detectLanguage("")).toBe("mixed");
  });
});

describe("scriptCounts and Thai detection", () => {
  test("Lao and Thai are counted separately despite adjacent blocks", () => {
    const c = scriptCounts("ອາກອນ ภาษี tax");
    expect(c.lao).toBeGreaterThan(0);
    expect(c.thai).toBeGreaterThan(0);
    expect(c.latin).toBe(3);
  });

  test("clean Lao carries no Thai", () => {
    expect(containsThai("ອາກອນມູນຄ່າເພີ່ມ")).toBe(false);
    expect(containsThai("ภาษีมูลค่าเพิ่ม")).toBe(true);
  });
});

describe("resolveAnswerLang", () => {
  test("auto follows the question", () => {
    expect(resolveAnswerLang("auto", "ອັດຕາອາກອນແມ່ນເທົ່າໃດ")).toBe("lo");
    expect(resolveAnswerLang("auto", "What is the tax rate?")).toBe("en");
  });

  test("an explicit request always wins over the question's script", () => {
    expect(resolveAnswerLang("en", "ອັດຕາອາກອນແມ່ນເທົ່າໃດ")).toBe("en");
    expect(resolveAnswerLang("lo", "What is the tax rate?")).toBe("lo");
    expect(resolveAnswerLang("both", "What is the tax rate?")).toBe("both");
  });

  test("a genuinely mixed question resolves to Lao", () => {
    // This is a Lao accounting assistant over a Lao corpus; Lao is the safe default.
    expect(resolveAnswerLang("auto", "VAT rate ອາກອນ")).toBe("lo");
  });
});

describe("answerLanguageRule", () => {
  test("the English rule keeps Lao alongside rather than replacing it", () => {
    // CLAUDE.md: English glosses are added *alongside*, never *instead of*. An English
    // answer that silently dropped the Lao term would be exactly that substitution.
    const rule = answerLanguageRule("en").join("\n");
    expect(rule).toContain("alongside");
    expect(rule).toMatch(/parenthes/i);
  });

  test("the bilingual rule demands both versions carry the same citations", () => {
    const rule = answerLanguageRule("both").join("\n");
    expect(rule).toContain("[n]");
    expect(rule).toContain("## ລາວ");
    expect(rule).toContain("## English");
  });

  test("every mode produces at least one directive", () => {
    for (const lang of ["lo", "en", "both"] as const) {
      expect(answerLanguageRule(lang).length).toBeGreaterThan(0);
    }
  });
});

describe("createLaoJoiner streams non-Lao answers", () => {
  /** Feed a string one small chunk at a time, as generation does. */
  function stream(text: string, expectLao?: boolean): { firstAt: number; out: string } {
    const joiner = expectLao === undefined ? createLaoJoiner() : createLaoJoiner({ expectLao });
    let out = "";
    let firstAt = -1;
    const chunks = text.match(/.{1,8}/gs) ?? [];
    chunks.forEach((c, i) => {
      const t = joiner.feed(c);
      if (t !== "") {
        if (firstAt === -1) firstAt = i;
        out += t;
      }
    });
    out += joiner.flush();
    return { firstAt, out };
  }

  const ENGLISH =
    "The value-added tax rate is 10 percent [1]. It applies to goods and services " +
    "supplied in Laos, with the exemptions listed in the source [2].";

  test("an English answer starts streaming immediately when Lao is not expected", () => {
    const { firstAt, out } = stream(ENGLISH, false);
    expect(firstAt).toBe(0);
    expect(out).toBe(ENGLISH);
  });

  test("an English answer still streams before the end when the caller said nothing", () => {
    // The regression this guards: with only a Lao-run counter, an answer containing no
    // Lao never satisfied the verdict, so feed() returned "" for every chunk and the
    // entire answer arrived at flush() — an empty "writing" state until generation ended.
    const { firstAt, out } = stream(ENGLISH);
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(firstAt).toBeLessThan((ENGLISH.match(/.{1,8}/gs) ?? []).length - 1);
    expect(out).toBe(ENGLISH);
  });

  test("Lao output is unaffected — spaced Lao is still rejoined", () => {
    const spaced = "ອາກອນ ມູນຄ່າ ເພີ່ມ ແມ່ນ ອາກອນ ທາງ ອ້ອມ ທີ່ ເກັບ ຈາກ ຜູ້ ບໍລິໂພກ.";
    const { out } = stream(spaced, true);
    expect(out).not.toBe(spaced);
    expect(out).toContain("ອາກອນມູນຄ່າເພີ່ມ");
  });
});

describe("restoreInitialismSpacing", () => {
  test("puts the space back into ສປປ ລາວ", () => {
    // The drafter emits ສປປລາວ despite an explicit prompt rule saying not to. The list is
    // closed and the correct form is deterministic, so it is repaired rather than hoped for.
    expect(restoreInitialismSpacing("ຢູ່ສປປລາວແມ່ນ 10%")).toContain("ສປປ ລາວ");
  });

  test("is idempotent", () => {
    const once = restoreInitialismSpacing("ຢູ່ສປປລາວ");
    expect(restoreInitialismSpacing(once)).toBe(once);
  });

  test("leaves a real word ending in those letters alone", () => {
    // The guard that makes this safe: only a standalone initialism is matched, so a word
    // that merely ends in ສປປ is not split down the middle.
    const text = "ອາກອນມູນຄ່າເພີ່ມແມ່ນອາກອນທາງອ້ອມ";
    expect(restoreInitialismSpacing(text)).toBe(text);
  });
});

describe("the joiner restores initialism spacing in unsegmented Lao", () => {
  /** Feed one small chunk at a time and assert the emitted text is never rewritten. */
  function streamStable(text: string): { out: string; prefixStable: boolean } {
    const joiner = createLaoJoiner();
    let out = "";
    let stable = true;
    for (const c of text.match(/.{1,4}/gs) ?? []) {
      const before = out;
      out += joiner.feed(c);
      // Everything already emitted must still be a prefix of everything emitted so far.
      if (!out.startsWith(before)) stable = false;
    }
    out += joiner.flush();
    return { out, prefixStable: stable };
  }

  test("ສປປລາວ written without a space is repaired", () => {
    // The chat generator writes natural, unsegmented Lao — the register the old joiner
    // left untouched — so this repair never reached a real answer before.
    const { out } = streamStable("ອາກອນມູນຄ່າເພີ່ມເກັບຢູ່ສປປລາວທຸກຂັ້ນຕອນ.");
    expect(out).toContain("ສປປ ລາວ");
  });

  test("the emitted prefix is never rewritten while doing it", () => {
    // Inserting a space is the risky direction: emitting `ຢູ່ສປປ` and then deciding the
    // text reads `ຢູ່ ສປປ ລາວ` would rewrite what the reader already saw.
    const { out, prefixStable } = streamStable("ເກັບຢູ່ສປປລາວແລ້ວ.");
    expect(prefixStable).toBe(true);
    expect(out).toContain("ສປປ ລາວ");
  });

  test("an already-correct initialism is left alone", () => {
    const { out } = streamStable("ອາກອນຢູ່ ສປປ ລາວ ແມ່ນ 10%.");
    expect(out).toContain("ສປປ ລາວ");
    expect(out).not.toContain("ສປປ  ລາວ");
  });

  test("segmented Lao still joins, and keeps the initialism spaced", () => {
    const { out } = streamStable("ອາກອນ ມູນຄ່າ ເພີ່ມ ເກັບ ຢູ່ ສປປ ລາວ ທຸກ ຂັ້ນ ຕອນ.");
    expect(out).toContain("ອາກອນມູນຄ່າເພີ່ມ");
    expect(out).toContain("ສປປ ລາວ");
  });
});
