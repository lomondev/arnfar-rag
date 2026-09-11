import { afterAll, describe, expect, test } from "bun:test";
import { schema } from "@arnfar/db";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../../lib/db.ts";
import { newId } from "../../../lib/ids.ts";
import { devTenant } from "../../../lib/tenant.ts";
import {
  getLesson,
  listLessonsForCurator,
  listLessonsForStudent,
  recordProgress,
} from "../service.ts";

/**
 * The tutor's non-negotiable rules, asserted against a real database.
 *
 * The one that matters most: **an unverified lesson is invisible to a student.** Every
 * other guarantee in this codebase about unreviewed material — rejected chunks never
 * retrieved, unverified QA never exported — exists because shipping unreviewed content is
 * the failure that does real damage. A tutor makes it worse: a student memorises what they
 * are taught, so a wrong lesson is not a wrong answer, it is a wrong belief.
 *
 * Skipped without a database, exactly like the RLS and export suites.
 */

const configured = Boolean(process.env.DATABASE_URL && process.env.DEV_HF_ID);

describe.skipIf(!configured)("tutor invariants", () => {
  const tenant = devTenant();
  const subjectIds: string[] = [];
  const lessonIds: string[] = [];
  const studentIds: string[] = [];
  const docIds: string[] = [];
  const chunkIds: string[] = [];

  async function seedChunk(): Promise<string> {
    const documentId = newId();
    await db()
      .insert(schema.ragDocument)
      .values({
        id: documentId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        collection: "learn-test",
        title: "ເອກະສານ ບົດຮຽນ",
        sourceFilename: `learn-${documentId}.docx`,
        sourceUri: `originals/learn/${documentId}.docx`,
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
      collection: "learn-test",
      seq: 0,
      content: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
      contentNorm: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
      contentSeg: "ອັດຕາ ອາກອນມູນຄ່າເພີ່ມ ແມ່ນ 10%.",
      kind: "prose",
      lang: "lo",
      tokenCount: 10,
      review: "accepted",
    });
    chunkIds.push(chunkId);
    return chunkId;
  }

  async function seedSubject(): Promise<string> {
    const id = newId();
    await db()
      .insert(schema.subject)
      .values({
        id,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        // UUIDv7 leads with a timestamp, so ids minted in the same millisecond share
        // their first characters. The random tail is what makes this unique.
        key: `test-${id.replace(/-/g, "").slice(-12)}`,
        nameLo: "ວິຊາ ທົດສອບ",
        collections: ["learn-test"],
      });
    subjectIds.push(id);
    return id;
  }

  async function seedLesson(subjectId: string, verified: boolean, chunkId: string) {
    const id = newId();
    await db().insert(schema.lesson).values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      subjectId,
      titleLo: "ບົດຮຽນ ທົດສອບ",
      verified,
      source: "llm_draft",
    });
    lessonIds.push(id);
    await db()
      .insert(schema.lessonStep)
      .values({
        id: newId(),
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        lessonId: id,
        seq: 0,
        kind: "concept",
        bodyLo: "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
        citationIds: [chunkId],
      });
    return id;
  }

  afterAll(async () => {
    if (lessonIds.length) {
      await db().delete(schema.lesson).where(inArray(schema.lesson.id, lessonIds));
    }
    if (studentIds.length) {
      await db().delete(schema.student).where(inArray(schema.student.id, studentIds));
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

  test("an unverified lesson never appears in a student's list", async () => {
    const chunkId = await seedChunk();
    const subjectId = await seedSubject();
    const draft = await seedLesson(subjectId, false, chunkId);
    const live = await seedLesson(subjectId, true, chunkId);

    const studentIdsSeen = (await listLessonsForStudent(tenant, subjectId)).map((l) => l.id);
    expect(studentIdsSeen).toContain(live);
    expect(studentIdsSeen).not.toContain(draft);
  });

  test("a curator sees drafts — that IS the review queue", async () => {
    const chunkId = await seedChunk();
    const subjectId = await seedSubject();
    const draft = await seedLesson(subjectId, false, chunkId);

    const seen = (await listLessonsForCurator(tenant, subjectId)).map((l) => l.id);
    expect(seen).toContain(draft);
  });

  test("fetching an unverified lesson as a student is a miss, not a peek", async () => {
    const chunkId = await seedChunk();
    const subjectId = await seedSubject();
    const draft = await seedLesson(subjectId, false, chunkId);

    expect(await getLesson(tenant, draft, { studentView: true })).toBeNull();
    expect(await getLesson(tenant, draft, { studentView: false })).not.toBeNull();
  });

  test("an asserting step cannot be stored without a citation", async () => {
    const subjectId = await seedSubject();
    const lessonId = newId();
    await db().insert(schema.lesson).values({
      id: lessonId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      subjectId,
      titleLo: "ບົດຮຽນ ບໍ່ ມີ ອ້າງອີງ",
    });
    lessonIds.push(lessonId);

    // A 'concept' step teaches a fact, so it must say where the fact came from. The
    // database refuses it — this is the CHECK constraint, not application politeness.
    // Awaited inside a real Promise: a Drizzle query builder is a thenable, and
    // `.rejects` needs a genuine Promise to attach to.
    const insertUncited = (): Promise<unknown> =>
      (async () => {
        // `await` inside the body, not a concise return: returning the builder resolves
        // the promise with the builder object instead of running the insert.
        await db().insert(schema.lessonStep).values({
          id: newId(),
          hfId: tenant.hfId,
          companyId: tenant.companyId,
          lessonId,
          seq: 0,
          kind: "concept",
          bodyLo: "ອັດຕາອາກອນແມ່ນ 99%.",
          citationIds: [],
        });
      })();
    await expect(insertUncited()).rejects.toThrow(/lesson_step_citation_chk/);
  });

  test("an intro step may restate without citing", async () => {
    const subjectId = await seedSubject();
    const lessonId = newId();
    await db().insert(schema.lesson).values({
      id: lessonId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      subjectId,
      titleLo: "ບົດຮຽນ ມີ ບົດນຳ",
    });
    lessonIds.push(lessonId);

    await db().insert(schema.lessonStep).values({
      id: newId(),
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      lessonId,
      seq: 0,
      kind: "intro",
      bodyLo: "ໃນບົດຮຽນນີ້ ເຮົາຈະຮຽນກ່ຽວກັບອາກອນ.",
      citationIds: [],
    });

    const lesson = await getLesson(tenant, lessonId, { studentView: false });
    expect(lesson?.steps).toHaveLength(1);
  });

  test("progress only ever moves forward", async () => {
    const chunkId = await seedChunk();
    const subjectId = await seedSubject();
    const lessonId = await seedLesson(subjectId, true, chunkId);

    const studentId = newId();
    await db()
      .insert(schema.student)
      .values({
        id: studentId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        displayName: `ນັກຮຽນ ${studentId.replace(/-/g, "").slice(-12)}`,
      });
    studentIds.push(studentId);

    await recordProgress(tenant, studentId, lessonId, 5, false);
    // Re-reading step 2 of a lesson you got to step 5 of is looking something up, not
    // forgetting it. Without GREATEST this silently erased three steps of progress.
    const after = await recordProgress(tenant, studentId, lessonId, 2, false);
    expect(after?.furthestSeq).toBe(5);
  });

  test("completion is sticky", async () => {
    const chunkId = await seedChunk();
    const subjectId = await seedSubject();
    const lessonId = await seedLesson(subjectId, true, chunkId);

    const studentId = newId();
    await db()
      .insert(schema.student)
      .values({
        id: studentId,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        displayName: `ນັກຮຽນ ${studentId.replace(/-/g, "").slice(-12)}`,
      });
    studentIds.push(studentId);

    await recordProgress(tenant, studentId, lessonId, 3, true);
    const revisit = await recordProgress(tenant, studentId, lessonId, 1, false);
    expect(revisit?.completedAt).not.toBeNull();
  });
});
