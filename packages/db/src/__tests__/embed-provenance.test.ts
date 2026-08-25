import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

/**
 * The `embed_model` invariant, asserted against a real database.
 *
 * Migration 0004 adds a CHECK that a chunk can never name an embedding model without
 * carrying the vector that model produced. That pairing is the whole point of the column:
 * provenance you can trust is provenance the database refuses to let drift.
 *
 * Skipped when no database is configured, matching rls.test.ts. CI always provides one.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const HF = process.env.DEV_HF_ID as string;
const CO = process.env.DEV_COMPANY_ID as string;

const configured = Boolean(ADMIN_URL && HF && CO);

// Fixed ids so a crashed run leaves rows the next run can clean up.
const DOC = "018f9a1e-7c00-7000-8000-0000000000e1";
const CHUNK = "018f9a1e-7c00-7000-8000-0000000000e2";

async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(!configured)("embedding provenance", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(ADMIN_URL as string, { max: 1, onnotice: () => {} });
    await sql`DELETE FROM rag_document WHERE id = ${DOC}`;
    await sql`
      INSERT INTO rag_document
        (id, hf_id, company_id, collection, title, source_filename, source_uri,
         content_sha256, lang, license)
      VALUES
        (${DOC}, ${HF}, ${CO}, 'tax', 'PROVENANCE-FIXTURE', 'p.docx', 'test://p',
         ${"e".repeat(64)}, 'lo', 'internal')
    `;
    await sql`
      INSERT INTO rag_chunk
        (id, document_id, hf_id, company_id, collection, seq, content, content_norm,
         content_seg, lang, token_count)
      VALUES
        (${CHUNK}, ${DOC}, ${HF}, ${CO}, 'tax', 0, 'ບັນຊີ', 'ບັນຊີ', 'ບັນ ຊີ', 'lo', 2)
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM rag_document WHERE id = ${DOC}`;
    await sql.end({ timeout: 5 });
  });

  test("a freshly ingested chunk has neither a vector nor a model", async () => {
    const [row] = await sql<{ embedding: unknown; embed_model: string | null }[]>`
      SELECT embedding, embed_model FROM rag_chunk WHERE id = ${CHUNK}
    `;
    expect(row?.embedding).toBeNull();
    expect(row?.embed_model).toBeNull();
  });

  test("naming a model without a vector is refused", async () => {
    // The failure this prevents: a re-embed path that clears `embedding` but forgets
    // `embed_model`, leaving a row that claims provenance for a vector that is gone.
    const rejected = await refused(
      () => sql`UPDATE rag_chunk SET embed_model = 'bge-m3' WHERE id = ${CHUNK}`,
    );
    expect(rejected).toBe(true);
  });

  test("a vector and its model may be written together", async () => {
    const vec = `[${new Array(1024).fill(0.01).join(",")}]`;
    await sql`
      UPDATE rag_chunk SET embedding = ${vec}::halfvec, embed_model = 'bge-m3'
      WHERE id = ${CHUNK}
    `;
    const [row] = await sql<{ embed_model: string | null }[]>`
      SELECT embed_model FROM rag_chunk WHERE id = ${CHUNK}
    `;
    expect(row?.embed_model).toBe("bge-m3");
  });

  test("clearing the vector without clearing the model is refused", async () => {
    const rejected = await refused(
      () => sql`UPDATE rag_chunk SET embedding = NULL WHERE id = ${CHUNK}`,
    );
    expect(rejected).toBe(true);
  });

  test("clearing both together is allowed — that is the re-embed path", async () => {
    await sql`UPDATE rag_chunk SET embedding = NULL, embed_model = NULL WHERE id = ${CHUNK}`;
    const [row] = await sql<{ embed_model: string | null }[]>`
      SELECT embed_model FROM rag_chunk WHERE id = ${CHUNK}
    `;
    expect(row?.embed_model).toBeNull();
  });

  test("the census counts only embedded chunks", async () => {
    const rows = await sql<{ model: string | null; chunks: string }[]>`
      SELECT embed_model AS model, count(*)::text AS chunks
      FROM rag_chunk WHERE embedding IS NOT NULL AND id = ${CHUNK}
      GROUP BY embed_model
    `;
    // The fixture is currently unembedded, so it must not appear in a provenance census.
    expect(rows.length).toBe(0);
  });
});
