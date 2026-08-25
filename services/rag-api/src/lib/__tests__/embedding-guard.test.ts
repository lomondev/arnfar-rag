import { describe, expect, it } from "bun:test";

import { classifyCensus } from "../embedding-guard.ts";

const CONFIGURED = "bge-m3";

describe("classifyCensus", () => {
  it("reports an unembedded corpus as empty, not as a problem", () => {
    expect(classifyCensus([], CONFIGURED).kind).toBe("empty");
    // A census row can only exist for embedded chunks, but a zero count is not a model.
    expect(classifyCensus([{ model: "bge-m3", chunks: 0 }], CONFIGURED).kind).toBe("empty");
  });

  it("passes a corpus embedded entirely by the configured model", () => {
    const v = classifyCensus([{ model: "bge-m3", chunks: 1200 }], CONFIGURED);
    expect(v.kind).toBe("clean");
    if (v.kind === "clean") {
      expect(v.model).toBe("bge-m3");
      expect(v.chunks).toBe(1200);
    }
  });

  it("flags two named models as mixed", () => {
    const v = classifyCensus(
      [
        { model: "bge-m3", chunks: 900 },
        { model: "multilingual-e5-large", chunks: 300 },
      ],
      CONFIGURED,
    );
    expect(v.kind).toBe("mixed");
  });

  it("flags a corpus that agrees with itself but not with the query model", () => {
    // The subtle one: internally consistent, and still unsearchable — the query vector
    // comes from the configured model and shares no geometry with any of these.
    const v = classifyCensus([{ model: "multilingual-e5-large", chunks: 5000 }], CONFIGURED);
    expect(v.kind).toBe("mixed");
    if (v.kind === "mixed") expect(v.configured).toBe(CONFIGURED);
  });

  it("reports pre-0004 vectors as unknown provenance rather than clean", () => {
    const v = classifyCensus([{ model: null, chunks: 400 }], CONFIGURED);
    expect(v.kind).toBe("unknown-provenance");
    if (v.kind === "unknown-provenance") expect(v.chunks).toBe(400);
  });

  it("still reports unknown provenance when the rest of the corpus is correct", () => {
    const v = classifyCensus(
      [
        { model: "bge-m3", chunks: 900 },
        { model: null, chunks: 100 },
      ],
      CONFIGURED,
    );
    expect(v.kind).toBe("unknown-provenance");
  });

  it("ranks a mixed index above unknown provenance", () => {
    // Unknown rows might all be the right model; two named models definitely are not, so
    // the serious finding is the one that gets reported.
    const v = classifyCensus(
      [
        { model: "bge-m3", chunks: 900 },
        { model: "nomic-embed-text", chunks: 50 },
        { model: null, chunks: 100 },
      ],
      CONFIGURED,
    );
    expect(v.kind).toBe("mixed");
    if (v.kind === "mixed") expect(v.models).toHaveLength(3);
  });
});
