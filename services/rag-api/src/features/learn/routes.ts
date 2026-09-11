import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { DraftError, draftLesson } from "./draft.ts";
import { addStep, deleteStep, EditError, moveStep, updateLesson, updateStep } from "./edit.ts";
import { dueQuestions, nextIntervalHours, weakTopics } from "./practice.ts";
import {
  createStudent,
  createSubject,
  deleteLesson,
  deleteSubject,
  getCheckAnswer,
  getCitedChunks,
  getLesson,
  listLessonsForCurator,
  listLessonsForStudent,
  listProgress,
  listStudents,
  listSubjects,
  recordAttempt,
  recordProgress,
  unverifyLesson,
  verifyLesson,
} from "./service.ts";

/**
 * Tutor routes.
 *
 * The student and curator surfaces are separate paths on purpose. `/learn/*` serves
 * verified material only; `/learn/curator/*` serves everything. One route with a
 * `?includeDrafts` flag would put the safety of the student view one query-string typo
 * away from failing, and failing silently — the page renders either way.
 */
/** An edit that breaks a lesson invariant is a 422 with a readable sentence, not a 500.
 *  "a concept step must cite a source" is something a curator can act on; a constraint
 *  name and a correlation id are not. */
function editError(err: unknown, set: { status?: number | string }) {
  if (!(err instanceof EditError)) throw err;
  set.status = err.status;
  return { error: err.message };
}

const STEP_KIND = t.Union([
  t.Literal("intro"),
  t.Literal("concept"),
  t.Literal("example"),
  t.Literal("check"),
  t.Literal("recap"),
]);

export const learnRoutes = new Elysia({ prefix: "/learn" })
  // ── Subjects ───────────────────────────────────────────────────────────────
  .get("/subjects", async () => listSubjects(devTenant()))
  .post(
    "/subjects",
    async ({ body }) =>
      createSubject(devTenant(), {
        key: body.key,
        nameLo: body.nameLo,
        ...(body.nameEn ? { nameEn: body.nameEn } : {}),
        ...(body.descriptionLo ? { descriptionLo: body.descriptionLo } : {}),
        ...(body.descriptionEn ? { descriptionEn: body.descriptionEn } : {}),
        ...(body.collections ? { collections: body.collections } : {}),
        ...(body.seq !== undefined ? { seq: body.seq } : {}),
      }),
    {
      body: t.Object({
        key: t.String({ minLength: 1, maxLength: 60, pattern: "^[a-z0-9-]+$" }),
        nameLo: t.String({ minLength: 1, maxLength: 120 }),
        nameEn: t.Optional(t.String({ maxLength: 120 })),
        descriptionLo: t.Optional(t.String({ maxLength: 500 })),
        descriptionEn: t.Optional(t.String({ maxLength: 500 })),
        collections: t.Optional(t.Array(t.String())),
        seq: t.Optional(t.Integer({ minimum: 0 })),
      }),
    },
  )
  .delete("/subjects/:id", async ({ params }) => ({
    deleted: await deleteSubject(devTenant(), params.id),
  }))

  // ── Student-facing: verified lessons only ──────────────────────────────────
  .get("/lessons", async ({ query }) =>
    listLessonsForStudent(devTenant(), query.subjectId as string | undefined),
  )
  .get("/lessons/:id", async ({ params, set }) => {
    const lesson = await getLesson(devTenant(), params.id, { studentView: true });
    if (!lesson) {
      // 404, not 403: an unverified lesson must be indistinguishable from one that does
      // not exist, or the response itself leaks the review queue.
      set.status = 404;
      return { error: "lesson not found" };
    }
    return lesson;
  })

  /** The sources behind a step, in the order the step listed them. Rejected chunks are
   *  never returned — the same rule retrieval and export enforce. */
  .get("/citations", async ({ query }) => {
    const raw = typeof query.ids === "string" ? query.ids : "";
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    return getCitedChunks(devTenant(), ids);
  })

  /** The answer to a check step's question, read live from the verified pair. */
  .get("/qa/:id/answer", async ({ params, set }) => {
    const answer = await getCheckAnswer(devTenant(), params.id);
    if (!answer) {
      set.status = 404;
      return { error: "no verified question with that id" };
    }
    return answer;
  })

  // ── Students and progress ──────────────────────────────────────────────────
  .get("/students", async () => listStudents(devTenant()))
  .post(
    "/students",
    async ({ body }) => createStudent(devTenant(), body.displayName, body.lang ?? "lo"),
    {
      body: t.Object({
        displayName: t.String({ minLength: 1, maxLength: 80 }),
        lang: t.Optional(t.Union([t.Literal("lo"), t.Literal("en"), t.Literal("both")])),
      }),
    },
  )
  .get("/students/:id/progress", async ({ params }) => listProgress(devTenant(), params.id))
  .post(
    "/students/:id/progress",
    async ({ params, body, set }) => {
      const p = await recordProgress(
        devTenant(),
        params.id,
        body.lessonId,
        body.seq,
        body.completed ?? false,
      );
      if (!p) {
        set.status = 404;
        return { error: "student or lesson not found" };
      }
      return p;
    },
    {
      body: t.Object({
        lessonId: t.String(),
        seq: t.Integer({ minimum: 0 }),
        completed: t.Optional(t.Boolean()),
      }),
    },
  )

  // ── Practice ───────────────────────────────────────────────────────────────
  .get("/students/:id/due", async ({ params, query }) => {
    const limit = Number(query.limit ?? 10);
    const questions = await dueQuestions(devTenant(), params.id, Math.max(1, Math.min(50, limit)));
    return { questions, count: questions.length };
  })
  .get("/students/:id/weak", async ({ params }) => ({
    topics: await weakTopics(devTenant(), params.id),
  }))
  .post(
    "/students/:id/attempts",
    async ({ params, body }) => {
      const result = await recordAttempt(devTenant(), {
        studentId: params.id,
        qaPairId: body.qaPairId,
        correct: body.correct,
        ...(body.lessonStepId ? { lessonStepId: body.lessonStepId } : {}),
        ...(body.response ? { response: body.response } : {}),
        ...(body.elapsedMs ? { elapsedMs: body.elapsedMs } : {}),
      });
      // Tell the student when they will see this again — a schedule that is visible reads
      // as progress, and one that is not reads as randomness.
      return { ...result, nextInHours: nextIntervalHours(body.correct ? body.streak + 1 : 0) };
    },
    {
      body: t.Object({
        qaPairId: t.String(),
        correct: t.Boolean(),
        streak: t.Integer({ minimum: 0, default: 0 }),
        lessonStepId: t.Optional(t.String()),
        response: t.Optional(t.String({ maxLength: 2000 })),
        elapsedMs: t.Optional(t.Integer({ minimum: 0 })),
      }),
    },
  )

  // ── Curator-facing: drafts included ────────────────────────────────────────
  .get("/curator/lessons", async ({ query }) =>
    listLessonsForCurator(devTenant(), query.subjectId as string | undefined),
  )
  .get("/curator/lessons/:id", async ({ params, set }) => {
    const lesson = await getLesson(devTenant(), params.id, { studentView: false });
    if (!lesson) {
      set.status = 404;
      return { error: "lesson not found" };
    }
    return lesson;
  })
  .post(
    "/curator/lessons/draft",
    async ({ body, set }) => {
      try {
        return await draftLesson({
          tenant: devTenant(),
          subjectId: body.subjectId,
          topic: body.topic,
          ...(body.targetSteps ? { targetSteps: body.targetSteps } : {}),
          ...(body.model ? { model: body.model } : {}),
        });
      } catch (err) {
        if (err instanceof DraftError) {
          // A draft that cannot be built is a fact about the corpus the curator can act
          // on ("ingest material for this topic"), not a server fault.
          set.status = err.status;
          return { error: err.message };
        }
        throw err;
      }
    },
    {
      body: t.Object({
        subjectId: t.String(),
        topic: t.String({ minLength: 2, maxLength: 200 }),
        targetSteps: t.Optional(t.Integer({ minimum: 3, maximum: 12 })),
        model: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/curator/lessons/:id/verify",
    async ({ params, body, set }) => {
      const ok = await verifyLesson(devTenant(), params.id, body.reviewer ?? "dev");
      if (!ok) {
        set.status = 404;
        return { error: "lesson not found" };
      }
      return { id: params.id, verified: true };
    },
    { body: t.Object({ reviewer: t.Optional(t.String()) }) },
  )
  .patch("/curator/lessons/:id/unverify", async ({ params, set }) => {
    const ok = await unverifyLesson(devTenant(), params.id);
    if (!ok) {
      set.status = 404;
      return { error: "lesson not found" };
    }
    return { id: params.id, verified: false };
  })
  .delete("/curator/lessons/:id", async ({ params }) => ({
    deleted: await deleteLesson(devTenant(), params.id),
  }))

  // ── Editing ────────────────────────────────────────────────────────────────
  // Every mutation below withdraws the lesson's approval (features/learn/edit.ts):
  // approval is a statement about specific text, so changing the text withdraws it.
  .patch(
    "/curator/lessons/:id",
    async ({ params, body, set }) => {
      try {
        return await updateLesson(devTenant(), params.id, body);
      } catch (err) {
        return editError(err, set);
      }
    },
    {
      body: t.Object({
        titleLo: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        titleEn: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
        summaryLo: t.Optional(t.Union([t.String({ maxLength: 600 }), t.Null()])),
        summaryEn: t.Optional(t.Union([t.String({ maxLength: 600 }), t.Null()])),
        difficulty: t.Optional(t.Integer({ minimum: 1, maximum: 5 })),
        estimatedMinutes: t.Optional(t.Integer({ minimum: 1, maximum: 120 })),
      }),
    },
  )
  .patch(
    "/curator/steps/:id",
    async ({ params, body, set }) => {
      try {
        return await updateStep(devTenant(), params.id, body);
      } catch (err) {
        return editError(err, set);
      }
    },
    {
      body: t.Object({
        kind: t.Optional(STEP_KIND),
        titleLo: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
        titleEn: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
        bodyLo: t.Optional(t.Union([t.String({ maxLength: 4000 }), t.Null()])),
        bodyEn: t.Optional(t.Union([t.String({ maxLength: 4000 }), t.Null()])),
        // Unknown on purpose: the shape is the contract's `visualSpec`, validated by zod
        // in edit.ts so the curator gets the field and the reason, not a TypeBox dump.
        visual: t.Optional(t.Union([t.Unknown(), t.Null()])),
        citationIds: t.Optional(t.Array(t.String(), { maxItems: 12 })),
        qaPairId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .post(
    "/curator/lessons/:id/steps",
    async ({ params, body, set }) => {
      try {
        return await addStep(devTenant(), params.id, body);
      } catch (err) {
        return editError(err, set);
      }
    },
    {
      body: t.Object({
        kind: t.Optional(STEP_KIND),
        bodyLo: t.Optional(t.String({ maxLength: 4000 })),
        bodyEn: t.Optional(t.String({ maxLength: 4000 })),
        citationIds: t.Optional(t.Array(t.String(), { maxItems: 12 })),
      }),
    },
  )
  .delete("/curator/steps/:id", async ({ params, set }) => {
    try {
      await deleteStep(devTenant(), params.id);
      return { deleted: true };
    } catch (err) {
      return editError(err, set);
    }
  })
  .post(
    "/curator/steps/:id/move",
    async ({ params, body, set }) => {
      try {
        await moveStep(devTenant(), params.id, body.direction);
        return { moved: true };
      } catch (err) {
        return editError(err, set);
      }
    },
    { body: t.Object({ direction: t.Union([t.Literal("up"), t.Literal("down")]) }) },
  );
