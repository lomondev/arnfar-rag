import { describe, expect, test } from "bun:test";

import { candidatePool, RRF_POOL_MIN } from "../query.ts";

/**
 * The candidate pool is what keeps RRF stable at small page sizes. At k=1 a naive
 * pool of 4 lets one spurious dense neighbour outrank the real hit, and the symptom —
 * "the top answer is wrong sometimes" — is nearly impossible to trace back here. The
 * eval harness imports this same function so its baselines match production; a
 * hand-copied constant would drift and report numbers for a retriever nobody ran.
 */
describe("candidatePool", () => {
  test("never drops below the floor, however small k is", () => {
    for (const k of [1, 2, 5, 10, 25]) {
      expect(candidatePool(k)).toBeGreaterThanOrEqual(RRF_POOL_MIN);
    }
  });

  test("grows with k once 4k passes the floor", () => {
    expect(candidatePool(50)).toBe(200);
    expect(candidatePool(100)).toBe(400);
  });

  test("switches over exactly at the floor", () => {
    expect(candidatePool(RRF_POOL_MIN / 4)).toBe(RRF_POOL_MIN);
    expect(candidatePool(RRF_POOL_MIN / 4 + 1)).toBe(RRF_POOL_MIN + 4);
  });

  test("is monotonic — a bigger page never fuses fewer candidates", () => {
    let previous = 0;
    for (let k = 1; k <= 60; k++) {
      const pool = candidatePool(k);
      expect(pool).toBeGreaterThanOrEqual(previous);
      previous = pool;
    }
  });
});
