import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { schema } from "@arnfar/db";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../../lib/db.ts";
import { newId } from "../../../lib/ids.ts";
import { devTenant } from "../../../lib/tenant.ts";
import { exportDataset } from "../export.ts";

/**
 * The export invariants, asserted end to end against a real database.
 *
 * CLAUDE.md calls these non-negotiable, and they are the ones with real-world
 * consequences: a rejected chunk that reaches a shipped dataset is bad data, an uncited
 * accounting claim is a liability, and a client-confidential row in a shareable export is
 * a breach. Until now each was enforced by a query predicate that nothing verified.
 *
 * Skipped without a database, exactly like the RLS suite.
 */

const configured = Boolean(process.env.DATABASE_URL && process.env.DEV_HF_ID);

/** Well above any real version, so it can never collide with a genuine export. */
let versionCounter = 0;
const nextVersion = (): string => `990.0.${versionCounter++}`;

interface Seeded {
  documentId: string;
  chunkIds: string[];
  qaIds: string[];
}

describe.skipIf(!configured)("export invariants", () => {
  const tenant = devTenant();
  const created: Seeded = { documentId: "", chunkIds: [], qaIds: [] };
  const dirsToRemove: string[] = [];

  async function chunk(
    documentId: string,
    content: string,
    review: "accepted" | "rejected",
  ): Promise<string> {
    const id = newId();
    await db().insert(schema.ragChunk).values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      documentId,
      collection: "tax",
      seq: created.chunkIds.length,
      kind: "prose",
      content,
      contentNorm: content,
      contentSeg: content,
      headingPath: [],
      tokenCount: 3,
      lang: "lo",
      review,
      meta: {},
    });
    created.chunkIds.push(id);
    return id;
  }

  async function qa(input: {
    question: string;
    citationIds: string[];
    verified: boolean;
  }): Promise<string> {
    const id = newId();
    await db().insert(schema.laoQaPair).values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      questionLo: input.question,
      answerLo: "ຄຳຕອບ",
      citationIds: input.citationIds,
      tags: [],
      difficulty: 1,
      collection: "tax",
      source: "human",
      split: "train",
      verified: input.verified,
    });
    created.qaIds.push(id);
    return id;
  }

  let acceptedChunkId = "";
  let rejectedChunkId = "";

  beforeAll(async () => {
    created.documentId = newId();
    await db()
      .insert(schema.ragDocument)
      .values({
        id: created.documentId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        collection: "tax",
        title: "EXPORT-INVARIANT-FIXTURE",
        sourceFilename: "fixture.docx",
        sourceUri: `test://export-invariants/${Date.now()}`,
        contentSha256: newId().replace(/-/g, "").padEnd(64, "0").slice(0, 64),
        lang: "lo",
        license: "client-confidential",
      });

    acceptedChunkId = await chunk(created.documentId, "ເນື້ອໃນທີ່ຮັບແລ້ວ", "accepted");
    rejectedChunkId = await chunk(created.documentId, "ເນື້ອໃນທີ່ປະຕິເສດ", "rejected");

    await qa({ question: "QA-VERIFIED-CITED", citationIds: [acceptedChunkId], verified: true });
    await qa({ question: "QA-UNCITED", citationIds: [], verified: true });
    await qa({ question: "QA-CITES-REJECTED", citationIds: [rejectedChunkId], verified: true });
    await qa({ question: "QA-UNVERIFIED", citationIds: [acceptedChunkId], verified: false });
  });

  afterEach(async () => {
    await Promise.all(dirsToRemove.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  afterAll(async () => {
    if (created.qaIds.length) {
      await db().delete(schema.laoQaPair).where(inArray(schema.laoQaPair.id, created.qaIds));
    }
    if (created.chunkIds.length) {
      await db().delete(schema.ragChunk).where(inArray(schema.ragChunk.id, created.chunkIds));
    }
    if (created.documentId) {
      await db().delete(schema.ragDocument).where(eq(schema.ragDocument.id, created.documentId));
    }
  });

  /** Run an export and read one of its JSONL files back as parsed rows. */
  async function runExport(opts: { shareable: boolean }) {
    const result = await exportDataset(tenant, nextVersion(), opts);
    dirsToRemove.push(result.dir);
    const readJsonl = (name: string): Record<string, unknown>[] => {
      const path = resolve(result.dir, name);
      const body = readFileSync(path, "utf8").trim();
      return body ? body.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    };
    return { result, readJsonl };
  }

  test("a rejected chunk never appears in the export", async () => {
    const { readJsonl } = await runExport({ shareable: false });
    const ids = readJsonl("chunks.jsonl").map((r) => r.id);
    expect(ids).toContain(acceptedChunkId);
    expect(ids).not.toContain(rejectedChunkId);
  });

  test("an uncited QA pair never exports, however verified it is", async () => {
    // "An uncited accounting claim is a liability" — the pair is verified=true, so only
    // the citation rule can be keeping it out.
    const { readJsonl } = await runExport({ shareable: false });
    const questions = readJsonl("qa_train.jsonl")
      .concat(readJsonl("qa_test.jsonl"))
      .map((r) => r.question ?? r.question_lo);
    expect(questions).not.toContain("QA-UNCITED");
  });

  test("a QA pair citing a rejected chunk never exports", async () => {
    const { readJsonl } = await runExport({ shareable: false });
    const questions = readJsonl("qa_train.jsonl")
      .concat(readJsonl("qa_test.jsonl"))
      .map((r) => r.question ?? r.question_lo);
    expect(questions).not.toContain("QA-CITES-REJECTED");
  });

  test("an unverified QA pair never exports", async () => {
    const { readJsonl } = await runExport({ shareable: false });
    const questions = readJsonl("qa_train.jsonl")
      .concat(readJsonl("qa_test.jsonl"))
      .map((r) => r.question ?? r.question_lo);
    expect(questions).not.toContain("QA-UNVERIFIED");
  });

  test("client-confidential rows are excluded from a shareable export", async () => {
    // The fixture document is licensed client-confidential, so every one of its chunks
    // must vanish when shareable — including the accepted one that otherwise qualifies.
    const { readJsonl } = await runExport({ shareable: true });
    const ids = readJsonl("chunks.jsonl").map((r) => r.id);
    expect(ids).not.toContain(acceptedChunkId);
    expect(ids).not.toContain(rejectedChunkId);
  });

  test("client-confidential rows are included in an internal export", async () => {
    const { readJsonl } = await runExport({ shareable: false });
    expect(readJsonl("chunks.jsonl").map((r) => r.id)).toContain(acceptedChunkId);
  });

  test("dropped QA pairs are reported rather than silently discarded", async () => {
    const { result } = await runExport({ shareable: false });
    expect(result.warnings.join(" ")).toMatch(/QA pair\(s\) dropped/);
  });

  test("the manifest carries a sha256 for every emitted file", async () => {
    const { result } = await runExport({ shareable: false });
    expect(result.files.length).toBeGreaterThan(0);
    for (const f of result.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("re-exporting the same version is refused — exports are immutable", async () => {
    const version = nextVersion();
    const first = await exportDataset(tenant, version, { shareable: false });
    dirsToRemove.push(first.dir);
    let refused = false;
    try {
      await exportDataset(tenant, version, { shareable: false });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test("a non-semver version is refused", async () => {
    let refused = false;
    try {
      await exportDataset(tenant, "latest", { shareable: false });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
