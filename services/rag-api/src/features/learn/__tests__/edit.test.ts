import { afterAll, describe, expect, test } from "bun:test";
import { schema } from "@arnfar/db";
import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../../../lib/db.ts";
import { newId } from "../../../lib/ids.ts";
import { devTenant } from "../../../lib/tenant.ts";
import { addStep, deleteStep, EditError, moveStep, updateLesson, updateStep } from "../edit.ts";
import { getLesson } from "../service.ts";

/**
 * Curator editing.
 *
 * The rule under test above all others: **an edit withdraws approval.** Without it a
 * curator could approve a lesson, then change a tax rate inside it, and the new number
 * would reach students carrying an approval nobody gave it. `updateQa` has enforced the
 * same rule for QA pairs since Phase 5; these tests hold lessons to it.
 *
 * Skipped without a database, like the RLS and export suites.
 */

const configured = Boolean(process.env.DATABASE_URL && process.env.DEV_HF_ID);

describe.skipIf(!configured)("lesson editing", () => {
  const tenant = devTenant();
  const lessonIds: string[] = [];
  const subjectIds: string[] = [];
  const docIds: string[] = [];
  const chunkIds: string[] = [];

  async function seedChunk(review: "accepted" | "rejected" = "accepted"): Promise<string> {
    const documentId = newId();
    await db()
      .insert(schema.ragDocument)
      .values({
        id: documentId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        collection: "edit-test",
        title: "ເອກະສານ ແກ້ໄຂ",
        sourceFilename: `edit-${documentId}.docx`,
        sourceUri: `originals/edit/${documentId}.docx`,
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
      collection: "edit-test",
      seq: 0,
      content: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
      contentNorm: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
      contentSeg: "ອັດຕາ ອາກອນມູນຄ່າເພີ່ມ ແມ່ນ 10%.",
      kind: "prose",
      lang: "lo",
      tokenCount: 10,
      review,
    });
    chunkIds.push(chunkId);
    return chunkId;
  }

  /** A verified lesson with `n` cited concept steps. */
  async function seedLesson(n: number, chunkId: string): Promise<string> {
    const subjectId = newId();
    await db()
      .insert(schema.subject)
      .values({
        id: subjectId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        key: `edit-${subjectId.replace(/-/g, "").slice(-12)}`,
        nameLo: "ວິຊາ ແກ້ໄຂ",
      });
    subjectIds.push(subjectId);

    const lessonId = newId();
    await db().insert(schema.lesson).values({
      id: lessonId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      subjectId,
      titleLo: "ບົດຮຽນ ແກ້ໄຂ",
      verified: true,
      verifiedBy: "test",
      verifiedAt: new Date(),
    });
    lessonIds.push(lessonId);

    for (let i = 0; i < n; i++) {
      await db()
        .insert(schema.lessonStep)
        .values({
          id: newId(),
          hfId: tenant.hfId,
          companyId: tenant.companyId,
          lessonId,
          seq: i,
          kind: "concept",
          bodyLo: `ຂັ້ນຕອນ ${i}`,
          citationIds: [chunkId],
        });
    }
    return lessonId;
  }

  const stepsOf = async (lessonId: string) =>
    db()
      .select({
        id: schema.lessonStep.id,
        seq: schema.lessonStep.seq,
        bodyLo: schema.lessonStep.bodyLo,
      })
      .from(schema.lessonStep)
      .where(eq(schema.lessonStep.lessonId, lessonId))
      .orderBy(asc(schema.lessonStep.seq));

  const isVerified = async (lessonId: string) =>
    (
      await db()
        .select({ verified: schema.lesson.verified })
        .from(schema.lesson)
        .where(eq(schema.lesson.id, lessonId))
    )[0]?.verified;

  afterAll(async () => {
    if (lessonIds.length) {
      await db().delete(schema.lesson).where(inArray(schema.lesson.id, lessonIds));
    }
    if (subjectIds.length) {
      await db().delete(schema.subject).where(inArray(schema.subject.id, subjectIds));
    }
    if (chunkIds.length) {
      await db().delete(schema.ragChunk).where(inArray(schema.ragChunk.id, chunkIds));
    }
    for (const id of docIds) {
      await db().delete(schema.ragDocument).where(eq(schema.ragDocument.id, id));
    }
  });

  test("editing a step withdraws the lesson's approval", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(2, chunkId);
    expect(await isVerified(lessonId)).toBe(true);

    const [first] = await stepsOf(lessonId);
    await updateStep(tenant, first!.id, { bodyLo: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 7%." });

    // The whole point: a changed rate must not inherit the old approval.
    expect(await isVerified(lessonId)).toBe(false);
    // And it is immediately invisible to students.
    expect(await getLesson(tenant, lessonId, { studentView: true })).toBeNull();
  });

  test("editing lesson metadata withdraws approval too", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(1, chunkId);
    await updateLesson(tenant, lessonId, { titleLo: "ຊື່ ໃໝ່" });
    expect(await isVerified(lessonId)).toBe(false);
  });

  test("a concept step cannot be stripped of its citations", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(1, chunkId);
    const [step] = await stepsOf(lessonId);

    await expect(updateStep(tenant, step!.id, { citationIds: [] })).rejects.toThrow(EditError);
    // Refused at the boundary, so the row is untouched rather than half-written.
    const after = await stepsOf(lessonId);
    expect(after[0]?.bodyLo).toBe("ຂັ້ນຕອນ 0");
  });

  test("an intro step MAY be uncited — changing kind is the escape hatch", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(1, chunkId);
    const [step] = await stepsOf(lessonId);
    await updateStep(tenant, step!.id, { kind: "intro", citationIds: [] });
    const detail = await getLesson(tenant, lessonId, { studentView: false });
    expect(detail?.steps[0]?.kind).toBe("intro");
    expect(detail?.steps[0]?.citationIds).toHaveLength(0);
  });

  test("a citation pointing at a rejected chunk is refused", async () => {
    const good = await seedChunk("accepted");
    const rejected = await seedChunk("rejected");
    const lessonId = await seedLesson(1, good);
    const [step] = await stepsOf(lessonId);

    // A chunk a reviewer threw out must not become a lesson's evidence.
    await expect(updateStep(tenant, step!.id, { citationIds: [rejected] })).rejects.toThrow(
      /rejected/,
    );
  });

  test("an invalid visual is refused with the field that is wrong", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(1, chunkId);
    const [step] = await stepsOf(lessonId);

    await expect(
      updateStep(tenant, step!.id, { visual: { type: "balance", left: [] } }),
    ).rejects.toThrow(EditError);
    // null clears it — the curator's way to drop a bad picture without losing the text.
    await updateStep(tenant, step!.id, { visual: null });
    const detail = await getLesson(tenant, lessonId, { studentView: false });
    expect(detail?.steps[0]?.visual).toBeNull();
  });

  test("deleting a step closes the gap in seq", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(4, chunkId);
    const before = await stepsOf(lessonId);
    await deleteStep(tenant, before[1]!.id);

    const after = await stepsOf(lessonId);
    // Contiguous from 0 — the UNIQUE (lesson_id, seq) index depends on it, and so does
    // "step n of m" making sense to a student.
    expect(after.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(after.map((s) => s.bodyLo)).toEqual(["ຂັ້ນຕອນ 0", "ຂັ້ນຕອນ 2", "ຂັ້ນຕອນ 3"]);
  });

  test("moving a step swaps it with its neighbour", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(3, chunkId);
    const before = await stepsOf(lessonId);

    await moveStep(tenant, before[2]!.id, "up");
    const after = await stepsOf(lessonId);
    expect(after.map((s) => s.bodyLo)).toEqual(["ຂັ້ນຕອນ 0", "ຂັ້ນຕອນ 2", "ຂັ້ນຕອນ 1"]);
    expect(after.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  test("moving past either end is a no-op, not an error", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(2, chunkId);
    const before = await stepsOf(lessonId);

    await moveStep(tenant, before[0]!.id, "up");
    await moveStep(tenant, before[1]!.id, "down");
    const after = await stepsOf(lessonId);
    expect(after.map((s) => s.seq)).toEqual([0, 1]);
  });

  test("a new step is appended and must obey the citation rule", async () => {
    const chunkId = await seedChunk();
    const lessonId = await seedLesson(2, chunkId);

    await expect(addStep(tenant, lessonId, { kind: "concept", bodyLo: "ບໍ່ມີອ້າງອີງ" })).rejects.toThrow(
      EditError,
    );
    await addStep(tenant, lessonId, {
      kind: "concept",
      bodyLo: "ຂັ້ນຕອນ ໃໝ່",
      citationIds: [chunkId],
    });
    const after = await stepsOf(lessonId);
    expect(after).toHaveLength(3);
    expect(after[2]?.seq).toBe(2);
  });
});
