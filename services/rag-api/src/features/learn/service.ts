import type { LessonDetail, LessonProgress, LessonSummary, Subject } from "@arnfar/contracts";
import { visualSpec } from "@arnfar/contracts";
import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";

/**
 * The tutor's read and write model.
 *
 * One rule runs through every function here: **a student sees verified lessons only.**
 * Curators see everything. The two are separate functions rather than one with a flag,
 * because a flag defaulting the wrong way is how unreviewed material reaches a learner,
 * and that failure is silent — the page renders perfectly either way.
 */

const tenantOf = (t: TenantContext, table: { hfId: unknown; companyId: unknown }) =>
  and(eq(table.hfId as never, t.hfId), eq(table.companyId as never, t.companyId));

// ── Subjects ────────────────────────────────────────────────────────────────────────

export async function listSubjects(tenant: TenantContext): Promise<Subject[]> {
  const rows = await db()
    .select()
    .from(schema.subject)
    .where(tenantOf(tenant, schema.subject))
    .orderBy(asc(schema.subject.seq), asc(schema.subject.nameLo));

  // Verified lessons only. A subject card that advertises nine lessons and opens onto two
  // is a worse first impression than a card that says two.
  const counts = await db()
    .select({ subjectId: schema.lesson.subjectId, n: count() })
    .from(schema.lesson)
    .where(and(tenantOf(tenant, schema.lesson), eq(schema.lesson.verified, true)))
    .groupBy(schema.lesson.subjectId);
  const countOf = new Map(counts.map((c) => [c.subjectId, Number(c.n)]));

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    nameLo: r.nameLo,
    nameEn: r.nameEn,
    descriptionLo: r.descriptionLo,
    descriptionEn: r.descriptionEn,
    collections: r.collections,
    seq: r.seq,
    lessonCount: countOf.get(r.id) ?? 0,
  }));
}

export interface SubjectInput {
  key: string;
  nameLo: string;
  nameEn?: string;
  descriptionLo?: string;
  descriptionEn?: string;
  collections?: string[];
  seq?: number;
}

export async function createSubject(tenant: TenantContext, input: SubjectInput) {
  const id = newId();
  await db()
    .insert(schema.subject)
    .values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      key: input.key,
      nameLo: input.nameLo,
      nameEn: input.nameEn ?? null,
      descriptionLo: input.descriptionLo ?? null,
      descriptionEn: input.descriptionEn ?? null,
      collections: input.collections ?? [],
      seq: input.seq ?? 0,
    });
  return { id };
}

export async function deleteSubject(tenant: TenantContext, id: string): Promise<boolean> {
  const rows = await db()
    .delete(schema.subject)
    .where(and(eq(schema.subject.id, id), tenantOf(tenant, schema.subject)))
    .returning({ id: schema.subject.id });
  return rows.length > 0;
}

// ── Lessons ─────────────────────────────────────────────────────────────────────────

function toSummary(r: typeof schema.lesson.$inferSelect, stepCount: number): LessonSummary {
  return {
    id: r.id,
    subjectId: r.subjectId,
    titleLo: r.titleLo,
    titleEn: r.titleEn,
    summaryLo: r.summaryLo,
    summaryEn: r.summaryEn,
    difficulty: r.difficulty,
    estimatedMinutes: r.estimatedMinutes,
    seq: r.seq,
    prerequisiteIds: r.prerequisiteIds,
    tags: r.tags,
    source: r.source,
    verified: r.verified,
    stepCount,
  };
}

async function stepCounts(lessonIds: string[]): Promise<Map<string, number>> {
  if (!lessonIds.length) return new Map();
  const rows = await db()
    .select({ lessonId: schema.lessonStep.lessonId, n: count() })
    .from(schema.lessonStep)
    .where(inArray(schema.lessonStep.lessonId, lessonIds))
    .groupBy(schema.lessonStep.lessonId);
  return new Map(rows.map((r) => [r.lessonId, Number(r.n)]));
}

/** What a STUDENT may list: verified lessons only. */
export async function listLessonsForStudent(
  tenant: TenantContext,
  subjectId?: string,
): Promise<LessonSummary[]> {
  const rows = await db()
    .select()
    .from(schema.lesson)
    .where(
      and(
        tenantOf(tenant, schema.lesson),
        eq(schema.lesson.verified, true),
        ...(subjectId ? [eq(schema.lesson.subjectId, subjectId)] : []),
      ),
    )
    .orderBy(asc(schema.lesson.seq), asc(schema.lesson.titleLo));
  const counts = await stepCounts(rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, counts.get(r.id) ?? 0));
}

/** What a CURATOR may list: everything, drafts first — that is the review queue. */
export async function listLessonsForCurator(
  tenant: TenantContext,
  subjectId?: string,
): Promise<LessonSummary[]> {
  const rows = await db()
    .select()
    .from(schema.lesson)
    .where(
      and(
        tenantOf(tenant, schema.lesson),
        ...(subjectId ? [eq(schema.lesson.subjectId, subjectId)] : []),
      ),
    )
    .orderBy(asc(schema.lesson.verified), asc(schema.lesson.seq));
  const counts = await stepCounts(rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, counts.get(r.id) ?? 0));
}

/** Parse a stored visual back through the shared schema.
 *
 *  Stored as jsonb, so nothing in the database guarantees its shape — a hand-edited row or
 *  an older draft format would otherwise reach the renderer as an unrecognised type and
 *  blank the step. An unparseable visual degrades to no visual; the teaching text stays. */
function parseVisual(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  const parsed = visualSpec.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function getLesson(
  tenant: TenantContext,
  id: string,
  opts: { studentView: boolean },
): Promise<LessonDetail | null> {
  const rows = await db()
    .select()
    .from(schema.lesson)
    .where(
      and(
        eq(schema.lesson.id, id),
        tenantOf(tenant, schema.lesson),
        // The student path filters in SQL rather than checking after the fetch: an
        // unverified lesson must be indistinguishable from a missing one.
        ...(opts.studentView ? [eq(schema.lesson.verified, true)] : []),
      ),
    )
    .limit(1);
  const l = rows[0];
  if (!l) return null;

  const steps = await db()
    .select()
    .from(schema.lessonStep)
    .where(eq(schema.lessonStep.lessonId, id))
    .orderBy(asc(schema.lessonStep.seq));

  return {
    ...toSummary(l, steps.length),
    steps: steps.map((s) => ({
      id: s.id,
      seq: s.seq,
      kind: (["intro", "concept", "example", "check", "recap"] as const).includes(s.kind as never)
        ? (s.kind as LessonDetail["steps"][number]["kind"])
        : "concept",
      titleLo: s.titleLo,
      titleEn: s.titleEn,
      bodyLo: s.bodyLo,
      bodyEn: s.bodyEn,
      visual: parseVisual(s.visual),
      qaPairId: s.qaPairId,
      citationIds: s.citationIds,
    })),
  };
}

export async function verifyLesson(
  tenant: TenantContext,
  id: string,
  verifiedBy: string,
): Promise<boolean> {
  const rows = await db()
    .update(schema.lesson)
    .set({ verified: true, verifiedBy, verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.lesson.id, id), tenantOf(tenant, schema.lesson)))
    .returning({ id: schema.lesson.id });
  return rows.length > 0;
}

/** Send a lesson back to draft. Used when review finds a problem after approval — the
 *  student-facing list is filtered on `verified`, so this removes it immediately. */
export async function unverifyLesson(tenant: TenantContext, id: string): Promise<boolean> {
  const rows = await db()
    .update(schema.lesson)
    .set({ verified: false, verifiedBy: null, verifiedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.lesson.id, id), tenantOf(tenant, schema.lesson)))
    .returning({ id: schema.lesson.id });
  return rows.length > 0;
}

export async function deleteLesson(tenant: TenantContext, id: string): Promise<boolean> {
  const rows = await db()
    .delete(schema.lesson)
    .where(and(eq(schema.lesson.id, id), tenantOf(tenant, schema.lesson)))
    .returning({ id: schema.lesson.id });
  return rows.length > 0;
}

// ── Citations ───────────────────────────────────────────────────────────────────────

export interface CitedChunk {
  id: string;
  content: string;
  title: string | null;
}

/**
 * The chunks a lesson step cites — what "why?" opens for a student.
 *
 * Excludes rejected chunks, exactly as retrieval does. A chunk a reviewer threw out must
 * not reappear because a lesson drafted before the rejection still points at it; that is
 * the same rule CLAUDE.md states for retrieval and export, applied to the one other place
 * a chunk is now shown to a human.
 */
export async function getCitedChunks(tenant: TenantContext, ids: string[]): Promise<CitedChunk[]> {
  if (!ids.length) return [];
  const rows = await db()
    .select({
      id: schema.ragChunk.id,
      content: schema.ragChunk.content,
      title: schema.ragDocument.title,
    })
    .from(schema.ragChunk)
    .innerJoin(schema.ragDocument, eq(schema.ragChunk.documentId, schema.ragDocument.id))
    .where(
      and(
        inArray(schema.ragChunk.id, ids),
        tenantOf(tenant, schema.ragChunk),
        ne(schema.ragChunk.review, "rejected"),
      ),
    );
  // Preserve the order the step listed them in, so [1] in the text is the first panel.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => r !== undefined)
    .map((r) => ({ id: r.id, content: r.content, title: r.title }));
}

export interface CheckAnswer {
  qaPairId: string;
  answerLo: string;
  answerEn: string | null;
}

/**
 * The answer to a check step's question.
 *
 * Fetched by id rather than stored on the step, so the answer a student is shown is always
 * the verified pair's current text. Copying it into lesson content at draft time would let
 * the two drift, and the lesson copy would be the unreviewed one.
 *
 * `verified = true` is re-asserted here even though only verified pairs are ever attached:
 * a pair can be un-verified after a lesson was built, and at that moment it must stop
 * being shown as an answer.
 */
export async function getCheckAnswer(
  tenant: TenantContext,
  qaPairId: string,
): Promise<CheckAnswer | null> {
  const rows = await db()
    .select({
      id: schema.laoQaPair.id,
      answerLo: schema.laoQaPair.answerLo,
      answerEn: schema.laoQaPair.answerEn,
    })
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.id, qaPairId),
        tenantOf(tenant, schema.laoQaPair),
        eq(schema.laoQaPair.verified, true),
      ),
    )
    .limit(1);
  const r = rows[0];
  return r ? { qaPairId: r.id, answerLo: r.answerLo, answerEn: r.answerEn } : null;
}

// ── Students and progress ───────────────────────────────────────────────────────────

export async function listStudents(tenant: TenantContext) {
  return db()
    .select({
      id: schema.student.id,
      displayName: schema.student.displayName,
      lang: schema.student.lang,
    })
    .from(schema.student)
    .where(tenantOf(tenant, schema.student))
    .orderBy(asc(schema.student.displayName));
}

export async function createStudent(
  tenant: TenantContext,
  displayName: string,
  lang: "lo" | "en" | "both",
) {
  const id = newId();
  await db()
    .insert(schema.student)
    .values({ id, hfId: tenant.hfId, companyId: tenant.companyId, displayName, lang });
  return { id, displayName, lang };
}

/**
 * Record that a student reached a step.
 *
 * `furthest_seq` only ever increases. Revisiting step 2 of a lesson you finished is
 * re-reading, not un-learning, and letting it move the marker backwards would erase real
 * progress every time someone looked something up.
 */
export async function recordProgress(
  tenant: TenantContext,
  studentId: string,
  lessonId: string,
  seq: number,
  completed: boolean,
): Promise<LessonProgress | null> {
  const now = new Date();
  // Bound as an ISO string and cast in SQL. Inside a raw `sql` template the driver
  // serialises bind parameters itself and throws on a Date — the same trap the answer
  // verification path hit.
  const nowIso = now.toISOString();
  await db()
    .insert(schema.lessonProgress)
    .values({
      id: newId(),
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      studentId,
      lessonId,
      furthestSeq: seq,
      completedAt: completed ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.lessonProgress.studentId, schema.lessonProgress.lessonId],
      set: {
        furthestSeq: sql`GREATEST(${schema.lessonProgress.furthestSeq}, ${seq})`,
        // Once completed, stays completed — the timestamp is the first completion.
        completedAt: completed
          ? sql`COALESCE(${schema.lessonProgress.completedAt}, ${nowIso}::timestamptz)`
          : sql`${schema.lessonProgress.completedAt}`,
        updatedAt: now,
      },
    });

  const rows = await db()
    .select()
    .from(schema.lessonProgress)
    .where(
      and(
        eq(schema.lessonProgress.studentId, studentId),
        eq(schema.lessonProgress.lessonId, lessonId),
        tenantOf(tenant, schema.lessonProgress),
      ),
    )
    .limit(1);
  const p = rows[0];
  if (!p) return null;
  return {
    lessonId: p.lessonId,
    furthestSeq: p.furthestSeq,
    completedAt: p.completedAt?.toISOString() ?? null,
    startedAt: p.startedAt.toISOString(),
  };
}

export async function listProgress(
  tenant: TenantContext,
  studentId: string,
): Promise<LessonProgress[]> {
  const rows = await db()
    .select()
    .from(schema.lessonProgress)
    .where(
      and(eq(schema.lessonProgress.studentId, studentId), tenantOf(tenant, schema.lessonProgress)),
    );
  return rows.map((p) => ({
    lessonId: p.lessonId,
    furthestSeq: p.furthestSeq,
    completedAt: p.completedAt?.toISOString() ?? null,
    startedAt: p.startedAt.toISOString(),
  }));
}

/** Append one answer. Never updates: the history is the signal spaced repetition reads. */
export async function recordAttempt(
  tenant: TenantContext,
  input: {
    studentId: string;
    qaPairId: string;
    lessonStepId?: string;
    correct: boolean;
    response?: string;
    elapsedMs?: number;
  },
): Promise<{ id: string }> {
  const id = newId();
  await db()
    .insert(schema.quizAttempt)
    .values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      studentId: input.studentId,
      qaPairId: input.qaPairId,
      lessonStepId: input.lessonStepId ?? null,
      correct: input.correct,
      response: input.response ?? null,
      elapsedMs: input.elapsedMs ?? null,
    });
  return { id };
}
