/**
 * Retrieval metrics from a ranked id list vs the gold set.
 *
 * The aggregates return `null` for an empty sample rather than 0. That distinction is the
 * whole point: "no queries were measured" and "every query missed" are opposite facts, and
 * collapsing them to 0.0000 wrote three eval runs into this database that look like a
 * catastrophically broken retriever and are actually nothing at all. A gate decision reads
 * these numbers.
 */

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

/** Null for an empty sample — an unmeasured percentile is not 0 ms. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Null for an empty sample — an unmeasured mean is not 0. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Below this many gold queries, a recall figure is not gate evidence.
 *
 * At n=30 the 95% confidence interval on a proportion is already about ±0.18 — wide enough
 * that a measured 0.9 and a true 0.7 are indistinguishable. GATE 6 asks for recall@5 ≥ 0.9,
 * so anything under this cannot answer the question being asked of it. Runs below the line
 * still execute (early signal is useful); they are labelled, not suppressed.
 */
export const GATE_MIN_QUERIES = 30;

/** Whether a run's sample size can carry a gate decision. */
export function sampleVerdict(nQueries: number): {
  usable: boolean;
  gateEvidence: boolean;
  note: string | null;
} {
  if (nQueries === 0) {
    return { usable: false, gateEvidence: false, note: "no verified QA pairs to measure" };
  }
  if (nQueries < GATE_MIN_QUERIES) {
    return {
      usable: true,
      gateEvidence: false,
      note: `sample=${nQueries} — below the ${GATE_MIN_QUERIES}-query threshold for gate evidence`,
    };
  }
  return { usable: true, gateEvidence: true, note: null };
}

/**
 * precision@k: fraction of the top-k slots occupied by a gold id.
 *
 * The denominator is `k`, not `retrieved.length` — the standard IR definition, and the
 * one that keeps a short result list honest (the lexical arm routinely returns fewer than
 * k rows; scoring it out of what it happened to return would hide that).
 *
 * Read it with the gold-set size in mind. A `lao_qa_pair` usually carries 1–2
 * `citation_ids`, so precision@5 is capped at 0.2–0.4 no matter how perfect the ranking
 * is. It is a regression tripwire (a drop means junk climbed into the context window),
 * NOT a gate number — GATE 6 is recall@5. Use ndcgAtK for ranking quality.
 */
export function precisionAtK(retrieved: string[], gold: string[], k: number): number {
  if (k <= 0) return 0;
  const goldSet = new Set(gold);
  const hit = retrieved.slice(0, k).filter((id) => goldSet.has(id)).length;
  return hit / k;
}

/** hit rate@k: 1 when any gold id is in the top-k, else 0. Averaged over a run this is
 *  the "how often did the answer's source reach the context window at all" number, which
 *  is what a reader of a chat transcript actually experiences. */
export function hitRateAtK(retrieved: string[], gold: string[], k: number): number {
  const rank = hitRank(retrieved.slice(0, k), gold);
  return rank === null ? 0 : 1;
}

/** Discounted cumulative gain over binary relevance flags, positions 1..k. */
function dcg(relevance: number[], k: number): number {
  return relevance.slice(0, k).reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

/**
 * NDCG@k over BINARY relevance — the only kind this dataset has.
 *
 * `citation_ids` records which chunks support the answer; it does not grade them 3/2/1, so
 * every gold id is relevance 1 and the ideal ranking is simply "all gold, first". That
 * makes IDCG = dcg(1 repeated min(|gold|, k) times), and NDCG = 1.0 exactly when every
 * gold chunk that can fit in the window is at the top of it.
 *
 * This is the metric to watch when recall is already high but answers are still wrong:
 * recall@k cannot tell rank 1 from rank 10, and a generator with a 5-chunk context window
 * very much can.
 */
export function ndcgAtK(retrieved: string[], gold: string[], k: number): number {
  if (gold.length === 0 || k <= 0) return 0;
  const goldSet = new Set(gold);
  const actual = retrieved.slice(0, k).map((id) => (goldSet.has(id) ? 1 : 0));
  const ideal = new Array(Math.min(goldSet.size, k)).fill(1) as number[];
  const idcg = dcg(ideal, k);
  return idcg === 0 ? 0 : dcg(actual, k) / idcg;
}
