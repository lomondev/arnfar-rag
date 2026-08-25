import { describe, expect, it } from "bun:test";

import {
  GATE_MIN_QUERIES,
  hitRank,
  hitRateAtK,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  sampleVerdict,
} from "../metrics.ts";

describe("aggregates distinguish 'not measured' from 'measured zero'", () => {
  it("returns null for an empty sample, never 0", () => {
    // The bug this encodes: mean([]) === 0 wrote recall=0.0000 into eval_run for three runs
    // that measured nothing, which is indistinguishable from a retriever that missed every
    // query. GATE 6 is decided on these numbers.
    expect(mean([])).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it("still returns 0 when zero is the actual answer", () => {
    expect(mean([0, 0, 0])).toBe(0);
    expect(percentile([0], 95)).toBe(0);
  });

  it("averages a real sample", () => {
    expect(mean([1, 0])).toBe(0.5);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});

describe("recallAtK", () => {
  it("counts gold ids inside the top k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["a", "z"], 3)).toBe(0.5);
    expect(recallAtK(["a", "b", "c"], ["c"], 2)).toBe(0);
  });

  it("is 0 for an empty gold set rather than dividing by zero", () => {
    expect(recallAtK(["a"], [], 5)).toBe(0);
  });
});

describe("hitRank / reciprocalRank", () => {
  it("reports the 1-based rank of the first gold hit", () => {
    expect(hitRank(["a", "b", "c"], ["c"])).toBe(3);
    expect(reciprocalRank(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3);
  });

  it("reports a miss as null / 0", () => {
    expect(hitRank(["a"], ["z"])).toBeNull();
    expect(reciprocalRank(["a"], ["z"])).toBe(0);
  });
});

describe("sampleVerdict", () => {
  it("refuses a sample of zero — nothing to measure", () => {
    const v = sampleVerdict(0);
    expect(v.usable).toBe(false);
    expect(v.gateEvidence).toBe(false);
    expect(v.note).toContain("no verified QA pairs");
  });

  it("runs a small sample but denies it gate authority", () => {
    const v = sampleVerdict(GATE_MIN_QUERIES - 1);
    expect(v.usable).toBe(true);
    expect(v.gateEvidence).toBe(false);
    expect(v.note).toContain(String(GATE_MIN_QUERIES));
  });

  it("accepts a sample at the threshold as gate evidence", () => {
    const v = sampleVerdict(GATE_MIN_QUERIES);
    expect(v.usable).toBe(true);
    expect(v.gateEvidence).toBe(true);
    expect(v.note).toBeNull();
  });
});

describe("precisionAtK", () => {
  it("divides by k, not by however many rows came back", () => {
    // The lexical arm routinely returns fewer than k. Scoring it out of its own short
    // list would report 1.000 for a retriever that found one row and missed the rest.
    expect(precisionAtK(["a"], ["a"], 5)).toBeCloseTo(0.2);
    expect(precisionAtK(["a", "b", "c", "d", "e"], ["a", "b"], 5)).toBeCloseTo(0.4);
  });

  it("ignores gold ids below the cut", () => {
    expect(precisionAtK(["x", "y", "z", "a"], ["a"], 3)).toBe(0);
  });

  it("is 0 for k <= 0 rather than dividing by zero", () => {
    expect(precisionAtK(["a"], ["a"], 0)).toBe(0);
  });
});

describe("hitRateAtK", () => {
  it("is binary — one gold id in the window is a hit", () => {
    expect(hitRateAtK(["x", "y", "a"], ["a", "b"], 5)).toBe(1);
    expect(hitRateAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
  });

  it("is 0 for an empty gold set", () => {
    expect(hitRateAtK(["a"], [], 5)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("is 1.0 only when every reachable gold chunk is at the top", () => {
    expect(ndcgAtK(["a", "b", "c"], ["a", "b"], 3)).toBeCloseTo(1);
    expect(ndcgAtK(["a"], ["a"], 10)).toBeCloseTo(1);
  });

  it("separates rank 1 from rank 10 where recall@k cannot", () => {
    // Both retrieve the gold chunk inside the window, so recall@10 is 1.0 for each. The
    // generator only reads the top of that window; nDCG is the number that notices.
    const top = ndcgAtK(["a", "x", "y", "z", "w", "1", "2", "3", "4", "5"], ["a"], 10);
    const bottom = ndcgAtK(["x", "y", "z", "w", "1", "2", "3", "4", "5", "a"], ["a"], 10);
    expect(recallAtK(["a", "x"], ["a"], 10)).toBe(recallAtK(["x", "a"], ["a"], 10));
    expect(top).toBeCloseTo(1);
    expect(bottom).toBeLessThan(0.35);
    expect(top).toBeGreaterThan(bottom);
  });

  it("caps the ideal ranking at k, so a gold set larger than the window can still score 1", () => {
    // 3 gold chunks, a window of 2: retrieving two of them at ranks 1 and 2 is the best
    // any retriever can do at that depth, and must not be scored as a partial failure.
    expect(ndcgAtK(["a", "b"], ["a", "b", "c"], 2)).toBeCloseTo(1);
  });

  it("is 0 for a miss, an empty gold set, or k <= 0", () => {
    expect(ndcgAtK(["x", "y"], ["a"], 5)).toBe(0);
    expect(ndcgAtK(["a"], [], 5)).toBe(0);
    expect(ndcgAtK(["a"], ["a"], 0)).toBe(0);
  });
});
