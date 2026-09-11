import { afterAll, describe, expect, test } from "bun:test";
import { schema } from "@arnfar/db";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../../lib/db.ts";
import { newId } from "../../../lib/ids.ts";
import { devTenant } from "../../../lib/tenant.ts";
import { mineConversations } from "../mine.ts";

/**
 * Mining proposes; a person disposes.
 *
 * The rules that matter are the ones keeping unreviewed text out of a shipped dataset: a
 * mined pair is never verified, and a pair with no dataset citation is never created at
 * all — CLAUDE.md makes an uncited accounting claim unexportable, so proposing one only
 * fills the review queue with rows that can never leave it.
 *
 * Skipped without a database, exactly like the RLS and export suites.
 */

const configured = Boolean(process.env.DATABASE_URL && process.env.DEV_HF_ID);

describe.skipIf(!configured)("conversation mining", () => {
  const tenant = devTenant();
  const convIds: string[] = [];
  const docIds: string[] = [];
  const chunkIds: string[] = [];
  const qaIds: string[] = [];

  async function seedChunk(): Promise<string> {
    const documentId = newId();
    await db()
      .insert(schema.ragDocument)
      .values({
        id: documentId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        collection: "mine-test",
        title: "ເອກະສານ ທົດສອບ",
        sourceFilename: `mine-test-${documentId}.docx`,
        sourceUri: `originals/mine-test/${documentId}.docx`,
        lang: "lo",
        contentSha256: documentId.replace(/-/g, "").padEnd(64, "0"),
        status: "embedded",
      });
    docIds.push(documentId);

    const chunkId = newId();
    await db().insert(schema.ragChunk).values({
      id: chunkId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      documentId,
      collection: "mine-test",
      seq: 0,
      content: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
      contentNorm: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
      contentSeg: "ອັດຕາ ອາກອນມູນຄ່າເພີ່ມ ແມ່ນ 10%.",
      kind: "prose",
      lang: "lo",
      tokenCount: 12,
      review: "accepted",
    });
    chunkIds.push(chunkId);
    return chunkId;
  }

  /** One conversation with a user turn and an assistant turn carrying `sources`. */
  async function seedTurn(question: string, answer: string, sources: unknown): Promise<void> {
    const conversationId = newId();
    await db()
      .insert(schema.ragConversation)
      .values({
        id: conversationId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        title: question.slice(0, 40),
      });
    convIds.push(conversationId);

    const base = Date.now();
    await db()
      .insert(schema.ragMessage)
      .values({
        id: newId(),
        conversationId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        role: "user",
        content: question,
        createdAt: new Date(base),
      });
    await db()
      .insert(schema.ragMessage)
      .values({
        id: newId(),
        conversationId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        role: "assistant",
        content: answer,
        sources,
        createdAt: new Date(base + 1000),
      });
  }

  async function qaFor(question: string) {
    const rows = await db()
      .select()
      .from(schema.laoQaPair)
      .where(eq(schema.laoQaPair.questionLo, question));
    qaIds.push(...rows.map((r) => r.id));
    return rows;
  }

  afterAll(async () => {
    if (qaIds.length) {
      await db().delete(schema.laoQaPair).where(inArray(schema.laoQaPair.id, qaIds));
    }
    for (const id of convIds) {
      await db().delete(schema.ragConversation).where(eq(schema.ragConversation.id, id));
    }
    if (chunkIds.length) {
      await db().delete(schema.ragChunk).where(inArray(schema.ragChunk.id, chunkIds));
    }
    for (const id of docIds) {
      await db().delete(schema.ragDocument).where(eq(schema.ragDocument.id, id));
    }
  });

  const LONG_ANSWER =
    "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10% ຕາມທີ່ລະບຸໄວ້ໃນເອກະສານອ້າງອີງ [1]. " + "ອັດຕານີ້ນຳໃຊ້ກັບສິນຄ້າ ແລະ ການບໍລິການທົ່ວໄປ.";

  test("a cited turn becomes an UNVERIFIED chat_mined candidate", async () => {
    const chunkId = await seedChunk();
    const question = `ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນເທົ່າໃດ ${newId().slice(0, 8)}`;
    await seedTurn(question, LONG_ANSWER, [
      { n: 1, id: chunkId, origin: "dataset", content: "ອັດຕາ", title: "ເອກະສານ" },
    ]);

    const result = await mineConversations(tenant, { limit: 50, dryRun: false });
    expect(result.created).toBeGreaterThan(0);

    const row = (await qaFor(question))[0];
    expect(row).toBeDefined();
    // The invariant: mined text is a proposal, never dataset-ready.
    expect(row?.verified).toBe(false);
    expect(row?.source).toBe("chat_mined");
    expect(row?.citationIds).toContain(chunkId);
  });

  test("a turn citing only web sources is never proposed", async () => {
    const question = `what is the vat rate ${newId().slice(0, 8)}`;
    await seedTurn(question, LONG_ANSWER, [
      { n: 1, id: "web:https://example.com/vat", origin: "web", content: "10%", title: "Example" },
    ]);

    await mineConversations(tenant, { limit: 50, dryRun: false });

    // An uncited pair cannot export, so proposing one would only fill the queue.
    expect(await qaFor(question)).toHaveLength(0);
  });

  test("a mined turn is not proposed twice", async () => {
    const chunkId = await seedChunk();
    const question = `ໃບເກັບເງິນຕ້ອງມີຫຍັງແດ່ ${newId().slice(0, 8)}`;
    await seedTurn(question, LONG_ANSWER, [
      { n: 1, id: chunkId, origin: "dataset", content: "ໃບເກັບເງິນ", title: "ເອກະສານ" },
    ]);

    await mineConversations(tenant, { limit: 50, dryRun: false });
    await mineConversations(tenant, { limit: 50, dryRun: false });

    expect(await qaFor(question)).toHaveLength(1);
  });

  test("dryRun writes nothing", async () => {
    const chunkId = await seedChunk();
    const question = `ປິດບັນຊີທ້າຍງວດແນວໃດ ${newId().slice(0, 8)}`;
    await seedTurn(question, LONG_ANSWER, [
      { n: 1, id: chunkId, origin: "dataset", content: "ປິດບັນຊີ", title: "ເອກະສານ" },
    ]);

    const result = await mineConversations(tenant, { limit: 50, dryRun: true });
    expect(result.created).toBe(0);
    expect(result.candidates.some((c) => c.question === question)).toBe(true);
    expect(await qaFor(question)).toHaveLength(0);
  });
});
