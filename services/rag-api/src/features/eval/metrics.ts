/** Retrieval metrics from a ranked id list vs the gold set. */

/** 1-based rank of the first gold id in the ranked list, or null (miss). */
export function hitRank(retrieved: string[], gold: string[]): number | null {
  const goldSet = new Set(gold);
  for (let i = 0; i < retrieved.length; i++) {
    if (goldSet.has(retrieved[i]!)) return i + 1;
  }
  return null;
}

/** recall@k: fraction of gold ids present in the top-k retrieved. */
export function recallAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0) return 0;
  const topK = new Set(retrieved.slice(0, k));
  const hit = gold.filter((g) => topK.has(g)).length;
  return hit / gold.length;
}

/** Reciprocal rank (0 if miss). */
export function reciprocalRank(retrieved: string[], gold: string[]): number {
  const r = hitRank(retrieved, gold);
  return r === null ? 0 : 1 / r;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
