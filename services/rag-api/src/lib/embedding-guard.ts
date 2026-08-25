import { type EmbeddingCensusRow, embeddingCensus } from "@arnfar/db";

import { db } from "./db.ts";
import { env } from "./env.ts";
import { log } from "./logger.ts";

const elog = log.child("embeddings");

/** What the census says about whether this corpus can be searched coherently. */
export type EmbeddingVerdict =
  | { kind: "empty" }
  | { kind: "clean"; model: string; chunks: number }
  | { kind: "unknown-provenance"; chunks: number; configured: string }
  | { kind: "mixed"; models: EmbeddingCensusRow[]; configured: string };

/**
 * Classify an embedding census against the configured model.
 *
 * Pure, so the rule is testable without a database. The ordering is deliberate: a mixed
 * index is the serious finding and outranks unknown provenance, because unknown rows might
 * still all be the right model whereas two named models definitely are not.
 *
 * "Mixed" covers the case nobody expects — every row agreeing on a model that is not the
 * one this process will embed queries with. The query vector is what has to share geometry
 * with the corpus; a corpus that is internally consistent but foreign to the query model
 * retrieves just as badly as a half-and-half one.
 */
export function classifyCensus(
  census: readonly EmbeddingCensusRow[],
  configured: string,
): EmbeddingVerdict {
  const embedded = census.filter((r) => r.chunks > 0);
  if (embedded.length === 0) return { kind: "empty" };

  const named = embedded.filter((r) => r.model !== null);
  const unknown = embedded.find((r) => r.model === null);

  const foreign = named.filter((r) => r.model !== configured);
  if (named.length > 1 || foreign.length > 0) {
    return { kind: "mixed", models: [...embedded], configured };
  }

  if (unknown) return { kind: "unknown-provenance", chunks: unknown.chunks, configured };

  const only = named[0];
  if (!only?.model) return { kind: "empty" };
  return { kind: "clean", model: only.model, chunks: only.chunks };
}

/**
 * Report — at startup — whether the vectors in this corpus were all produced by the model
 * this process is configured to embed queries with.
 *
 * There is no error path in Postgres for getting this wrong. bge-m3 and
 * multilingual-e5-large are both 1024-dim, so `halfvec(1024)` accepts either and the HNSW
 * index will happily rank one against the other. The distances are meaningless and the
 * only symptom is that answers quietly get worse — which, for a product whose whole claim
 * is "cited or abstains", is the worst possible failure mode.
 *
 * Mirrors the tenant guard: fatal in production, loud in development, where a half-embedded
 * corpus mid-experiment is a legitimate place to be.
 */
export async function assertEmbeddingProvenance(): Promise<void> {
  let census: EmbeddingCensusRow[];
  try {
    census = await embeddingCensus(db());
  } catch (err) {
    elog.error("could not read embedding provenance", err);
    return;
  }

  const verdict = classifyCensus(census, env.embedModel);

  switch (verdict.kind) {
    case "empty":
      elog.info("no embedded chunks yet", { configured: env.embedModel });
      return;

    case "clean":
      elog.info("embedding provenance consistent", {
        model: verdict.model,
        chunks: verdict.chunks,
      });
      return;

    case "unknown-provenance":
      elog.warn("some vectors predate provenance tracking — cannot confirm they match", {
        chunks: verdict.chunks,
        configured: verdict.configured,
        remedy: "bun run db:reembed (or --stamp if you know what produced them)",
      });
      return;

    case "mixed": {
      const summary = verdict.models.map((r) => `${r.model ?? "unknown"}=${r.chunks}`).join(", ");
      const message =
        "vectors in this corpus were not all produced by the configured embedding model — " +
        "distances between them are meaningless and recall is degraded";
      const detail = { configured: verdict.configured, census: summary };
      if (process.env.NODE_ENV === "production") {
        elog.error(`${message}; refusing to serve`, undefined, {
          ...detail,
          remedy: "bun run db:reembed",
        });
        process.exit(1);
      }
      elog.error(message, undefined, { ...detail, remedy: "bun run db:reembed" });
      return;
    }
  }
}
