import type { TenantContext } from "@arnfar/db";
import { sql } from "drizzle-orm";
import { db } from "../../lib/db.ts";

/**
 * The practice queue — spaced repetition over the verified question bank.
 *
 * No new content is generated and no new table is needed: `lao_qa_pair` already holds
 * human-verified, difficulty-graded questions, and `quiz_attempt` already records every
 * answer with its timestamp. Scheduling is therefore a query, not a subsystem.
 *
 * The interval schedule is the classic doubling ladder keyed on *consecutive* correct
 * answers, which is the part that matters: a question answered right three times running
 * is genuinely known, while one answered right, wrong, right is not — and a scheduler that
 * counted totals rather than streaks would keep showing the first and hide the second.
 *
 * Deliberately not SM-2. SM-2 needs a self-rated recall quality on every card, which is a
 * second thing to ask a student on every question and a well-known source of noisy input.
 * Streak-based intervals get most of the benefit from data already being collected.
 */

/** Hours until a question is due again, indexed by consecutive-correct streak. */
const INTERVALS_H = [0, 4, 24, 72, 168, 336, 720];

function intervalFor(streak: number): number {
  return INTERVALS_H[Math.min(streak, INTERVALS_H.length - 1)] ?? 720;
}

export interface DueQuestion {
  qaPairId: string;
  questionLo: string;
  questionEn: string | null;
  answerLo: string;
  answerEn: string | null;
  difficulty: number;
  citationIds: string[];
  /** Consecutive correct answers so far — 0 for a question never seen. */
  streak: number;
  /** true when this student has never attempted it. */
  isNew: boolean;
}

interface DueRow {
  qa_pair_id: string;
  question_lo: string;
  question_en: string | null;
  answer_lo: string;
  answer_en: string | null;
  difficulty: number;
  citation_ids: string[];
  streak: number;
  is_new: boolean;
  [key: string]: unknown;
}

/**
 * Questions this student should see now.
 *
 * Never-seen questions come first at equal priority to overdue ones, then the most overdue.
 * Only verified pairs are eligible — the same rule the export path enforces, for the same
 * reason: an unverified draft is not something to teach anyone.
 */
export async function dueQuestions(
  tenant: TenantContext,
  studentId: string,
  limit = 10,
  subjectCollections: string[] = [],
): Promise<DueQuestion[]> {
  // Built with sql.join, not interpolated whole: a bare JS array inside a raw template
  // is emitted as a record and Postgres refuses to cast a record to text[].
  const collectionPred = subjectCollections.length
    ? sql`AND q.collection IN (${sql.join(
        subjectCollections.map((c) => sql`${c}`),
        sql`, `,
      )})`
    : sql``;

  const rows = (await db().execute<DueRow>(sql`
    WITH attempts AS (
      SELECT qa_pair_id, correct, created_at,
             ROW_NUMBER() OVER (PARTITION BY qa_pair_id ORDER BY created_at DESC) AS rn
      FROM quiz_attempt
      WHERE hf_id = ${tenant.hfId} AND company_id = ${tenant.companyId}
        AND student_id = ${studentId}
    ),
    -- Consecutive correct answers counting back from the most recent. The trick is to
    -- find the most recent WRONG answer and count everything after it: a plain
    -- COUNT(correct) would call a question known that was missed four times and passed
    -- five, which is exactly the question that most needs asking again.
    streaks AS (
      SELECT qa_pair_id,
             COUNT(*) FILTER (
               WHERE correct AND rn < COALESCE(
                 (SELECT MIN(a2.rn) FROM attempts a2
                   WHERE a2.qa_pair_id = attempts.qa_pair_id AND NOT a2.correct),
                 2147483647)
             ) AS streak,
             MAX(created_at) AS last_seen
      FROM attempts
      GROUP BY qa_pair_id
    )
    SELECT q.id AS qa_pair_id, q.question_lo, q.question_en, q.answer_lo, q.answer_en,
           q.difficulty, q.citation_ids,
           COALESCE(s.streak, 0)::int AS streak,
           (s.qa_pair_id IS NULL) AS is_new
    FROM lao_qa_pair q
    LEFT JOIN streaks s ON s.qa_pair_id = q.id
    WHERE q.hf_id = ${tenant.hfId} AND q.company_id = ${tenant.companyId}
      AND q.verified = true
      ${collectionPred}
      AND (
        s.qa_pair_id IS NULL
        OR s.last_seen + make_interval(hours => (
             CASE LEAST(COALESCE(s.streak, 0), 6)
               WHEN 0 THEN 0 WHEN 1 THEN 4 WHEN 2 THEN 24 WHEN 3 THEN 72
               WHEN 4 THEN 168 WHEN 5 THEN 336 ELSE 720 END)) <= now()
      )
    -- New questions first, then whatever has been waiting longest.
    ORDER BY (s.qa_pair_id IS NULL) DESC, s.last_seen ASC NULLS FIRST, q.difficulty ASC
    LIMIT ${limit}
  `)) as unknown as DueRow[];

  return rows.map((r) => ({
    qaPairId: r.qa_pair_id,
    questionLo: r.question_lo,
    questionEn: r.question_en,
    answerLo: r.answer_lo,
    answerEn: r.answer_en,
    difficulty: Number(r.difficulty),
    citationIds: r.citation_ids ?? [],
    streak: Number(r.streak),
    isNew: Boolean(r.is_new),
  }));
}

export interface WeakTopic {
  qaPairId: string;
  questionLo: string;
  attempts: number;
  wrong: number;
  /** The lesson step that teaches this, when one does — the way back from a mistake to
   *  the explanation, which is the whole point of tracking mistakes at all. */
  lessonId: string | null;
  lessonTitleLo: string | null;
}

interface WeakRow {
  qa_pair_id: string;
  question_lo: string;
  attempts: number;
  wrong: number;
  lesson_id: string | null;
  lesson_title_lo: string | null;
  [key: string]: unknown;
}

/** What this student keeps getting wrong, worst first, each linked back to the lesson
 *  that teaches it. */
export async function weakTopics(
  tenant: TenantContext,
  studentId: string,
  limit = 10,
): Promise<WeakTopic[]> {
  const rows = (await db().execute<WeakRow>(sql`
    SELECT q.id AS qa_pair_id, q.question_lo,
           COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE NOT a.correct)::int AS wrong,
           l.id AS lesson_id, l.title_lo AS lesson_title_lo
    FROM quiz_attempt a
    JOIN lao_qa_pair q ON q.id = a.qa_pair_id
    -- The lesson is found through any step that quizzes this pair. LEFT so a question
    -- practised outside a lesson still appears; it just has nowhere to send them yet.
    LEFT JOIN lesson_step st ON st.qa_pair_id = q.id
    LEFT JOIN lesson l ON l.id = st.lesson_id AND l.verified = true
    WHERE a.hf_id = ${tenant.hfId} AND a.company_id = ${tenant.companyId}
      AND a.student_id = ${studentId}
    GROUP BY q.id, q.question_lo, l.id, l.title_lo
    HAVING COUNT(*) FILTER (WHERE NOT a.correct) > 0
    ORDER BY COUNT(*) FILTER (WHERE NOT a.correct) DESC, COUNT(*) DESC
    LIMIT ${limit}
  `)) as unknown as WeakRow[];

  return rows.map((r) => ({
    qaPairId: r.qa_pair_id,
    questionLo: r.question_lo,
    attempts: Number(r.attempts),
    wrong: Number(r.wrong),
    lessonId: r.lesson_id,
    lessonTitleLo: r.lesson_title_lo,
  }));
}

/** Hours until this question is due again, given its streak. Exported for the UI, which
 *  tells a student when they will see it next — the feedback that makes the schedule feel
 *  like progress rather than randomness. */
export function nextIntervalHours(streak: number): number {
  return intervalFor(streak);
}
