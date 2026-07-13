import { schema } from "@arnfar/db";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { embedAll } from "../../lib/ollama.ts";

const SELECT_BATCH = 128;

export interface EmbedProgress {
  embedded: number;
  remaining: number;
}

/** Embed chunks for a document that still lack an embedding.
 *
 *  Idempotent and resumable: it only ever touches rows WHERE embedding IS NULL, so
 *  a crash mid-way is recovered simply by running again. content_norm is the input
 *  (natural Lao) — never content_seg.
 */
export async function embedPendingForDocument(
  documentId: string,
  onProgress?: (p: EmbedProgress) => void,
): Promise<number> {
  let total = 0;
  while (true) {
    const pending = await db()
      .select({ id: schema.ragChunk.id, contentNorm: schema.ragChunk.contentNorm })
      .from(schema.ragChunk)
      .where(and(eq(schema.ragChunk.documentId, documentId), isNull(schema.ragChunk.embedding)))
      .limit(SELECT_BATCH);

    if (pending.length === 0) break;

    const vectors = await embedAll(pending.map((c) => c.contentNorm));

    // One UPDATE per chunk; ids are UUIDv7 so writes stay index-friendly.
    for (let i = 0; i < pending.length; i++) {
      await db()
        .update(schema.ragChunk)
        .set({ embedding: vectors[i]! })
        .where(eq(schema.ragChunk.id, pending[i]!.id));
    }
    total += pending.length;

    if (onProgress) {
      const rows = await db()
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.ragChunk)
        .where(and(eq(schema.ragChunk.documentId, documentId), isNull(schema.ragChunk.embedding)));
      onProgress({ embedded: total, remaining: rows[0]?.count ?? 0 });
    }
  }

  // All chunks embedded → mark the document embedded.
  const remainingRows = await db()
    .select({ remaining: sql<number>`count(*)::int` })
    .from(schema.ragChunk)
    .where(and(eq(schema.ragChunk.documentId, documentId), isNull(schema.ragChunk.embedding)));
  if ((remainingRows[0]?.remaining ?? 0) === 0) {
    await db()
      .update(schema.ragDocument)
      .set({ status: "embedded", updatedAt: new Date() })
      .where(eq(schema.ragDocument.id, documentId));
  }
  return total;
}
