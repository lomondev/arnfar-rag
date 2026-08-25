import { describe, expect, it } from "bun:test";
import type { StoredSource } from "../storage";
import { resolveCitation } from "../storage";

function source(n: number, over: Partial<StoredSource> = {}): StoredSource {
  return {
    n,
    id: `chunk-${n}`,
    content: `source ${n} body`,
    headingPath: [],
    kind: "prose",
    title: `source ${n}`,
    authority: null,
    effectiveDate: null,
    superseded: null,
    origin: "dataset",
    url: null,
    ...over,
  };
}

describe("resolveCitation", () => {
  const sources = [
    source(1, { content: "| ຂາຍ ສິນຄ້າ | 411 ແລະ 701 |" }),
    source(2, { content: "ອາກອນມູນຄ່າເພີ່ມ 10%" }),
    source(3, { content: "ບັນຊີ 47 ປັບສະກຸນຕ່າງປະເທດ" }),
  ];

  it("reads a well-formed marker as a 1-based index", () => {
    expect(resolveCitation(sources, 1)?.id).toBe("chunk-1");
    expect(resolveCitation(sources, 3)?.id).toBe("chunk-3");
  });

  it("falls back to the source containing the number when it is not an index", () => {
    // `[n]411` — gemma-3n-laos cites the account code, not the source ordinal.
    expect(resolveCitation(sources, 411)?.id).toBe("chunk-1");
    expect(resolveCitation(sources, 701)?.id).toBe("chunk-1");
  });

  it("matches the number as a standalone token, never inside a longer one", () => {
    // 41 lives inside "411" only — that is not a citation of account 41.
    expect(resolveCitation(sources, 41)).toBeNull();
    // 47 does stand alone in source 3, but only reachable via the fallback: it is out of
    // index range only when there are fewer than 47 sources, which is the real case.
    expect(resolveCitation(sources, 47)?.id).toBe("chunk-3");
  });

  it("resolves nothing for a bare marker or an empty answer", () => {
    expect(resolveCitation(sources, null)).toBeNull();
    expect(resolveCitation([], 1)).toBeNull();
    expect(resolveCitation(sources, 9999)).toBeNull();
  });

  it("prefers the index reading when the number is a valid ordinal", () => {
    // 3 is both a valid index and absent from every body — index wins, no search.
    expect(resolveCitation(sources, 3)?.id).toBe("chunk-3");
  });
});
