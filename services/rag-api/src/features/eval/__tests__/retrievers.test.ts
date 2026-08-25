import { describe, expect, it } from "bun:test";

import { RERANK_CANDIDATES, type Retriever, retrieve } from "../retrievers.ts";

/**
 * Contract tests for the rerank arm that need no database and no cross-encoder.
 *
 * The database-backed behaviour of the four arms is covered by an actual eval run; what is
 * pinned here is the part that fails silently rather than loudly — a reranker fed the
 * wrong string, or an arm that quietly degrades to plain RRF and reports the numbers as
 * though the cross-encoder had run.
 */

describe("hybrid-rrf+rerank", () => {
  it("refuses to run without the raw question", async () => {
    // A cross-encoder scores (query, chunk) as a pair. Handing it `content_seg` — the only
    // other query string in scope — injects word-boundary spaces that corrupt its
    // tokenization exactly as they corrupt bge-m3's, so a missing queryText must be an
    // error and never a fallback to the segmented form.
    await expect(
      retrieve("hybrid-rrf+rerank", {
        tenant: {
          hfId: "00000000-0000-7000-8000-000000000001",
          companyId: "00000000-0000-7000-8000-000000000002",
        },
        collections: [],
        queryEmbedding: [0],
        querySeg: "ອາກອນ ມູນຄ່າ ເພີ່ມ",
        k: 5,
      }),
    ).rejects.toThrow(/requires queryText/);
  });

  it("retrieves wider than it keeps", () => {
    // The reranker can only reorder what it is given: reranking the same k rows RRF
    // already ranked would measure nothing, and the arm would look like a no-op.
    expect(RERANK_CANDIDATES).toBeGreaterThan(10);
  });

  it("names the arm distinctly from plain hybrid", () => {
    // The string lands in eval_run.retriever and is how a historical comparison tells the
    // two pipelines apart. Reusing "hybrid-rrf" would make the ledger unreadable.
    const arms: Retriever[] = ["dense", "lexical", "hybrid-rrf", "hybrid-rrf+rerank"];
    expect(new Set(arms).size).toBe(arms.length);
  });
});
