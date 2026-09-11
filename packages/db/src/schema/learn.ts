import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { laoQaPair } from "./qa.ts";

/**
 * The tutor — lessons a student works through step by step.
 *
 * Deliberately subject-agnostic: `subject` is a row, not an enum, so the same engine
 * teaches accounting, tax, or anything else the tenant has ingested. What keeps it honest
 * is that a step's explanation is drafted FROM cited chunks and carries their ids — the
 * engine is general, but a lesson is only ever as free-invented as its citations allow.
 *
 * The verified/unverified split is the same discipline as everywhere else in this codebase:
 * drafting proposes, a person disposes, and only `verified = true` reaches a student.
 */

/** A top-level learning area. Points at the retrieval collections its lessons draw from. */
export const subject = pgTable(
  "subject",
  {
    id: uuid("id").primaryKey(), // UUIDv7, app-generated
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    /** Stable ascii slug used in URLs. */
    key: text("key").notNull(),
    nameLo: text("name_lo").notNull(),
    nameEn: text("name_en"),
    descriptionLo: text("description_lo"),
    descriptionEn: text("description_en"),
    /** Retrieval collections a lesson in this subject may cite. Empty = the whole corpus. */
    collections: text("collections").array().notNull().default(sql`'{}'::text[]`),
    /** Display order in the student's subject list. */
    seq: integer("seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("subject_tenant_key").on(t.hfId, t.companyId, t.key)],
);

/** An ordered course unit within a subject. */
export const lesson = pgTable(
  "lesson",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subject.id, { onDelete: "cascade" }),
    titleLo: text("title_lo").notNull(),
    titleEn: text("title_en"),
    /** One or two sentences shown on the lesson card, before a student commits to it. */
    summaryLo: text("summary_lo"),
    summaryEn: text("summary_en"),
    /** 1–5, same scale as lao_qa_pair.difficulty so the two can be compared. */
    difficulty: smallint("difficulty").notNull().default(2),
    /** Minutes, for the "how long will this take?" a student always asks first. */
    estimatedMinutes: integer("estimated_minutes").notNull().default(10),
    seq: integer("seq").notNull().default(0),
    /** Lessons this one assumes. A prerequisite that is not yet passed is shown, not
     *  hidden — a locked door with no explanation is worse than a warning. */
    prerequisiteIds: uuid("prerequisite_ids").array().notNull().default(sql`'{}'::uuid[]`),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** 'human' | 'llm_draft'. Provenance drives the review queue, as it does for QA. */
    source: text("source").notNull().default("llm_draft"),
    /** NOTHING unverified is ever served to a student. Enforced in the query, tested in
     *  features/learn/__tests__/invariants.test.ts. */
    verified: boolean("verified").notNull().default(false),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lesson_subject").on(t.hfId, t.companyId, t.subjectId, t.seq),
    index("lesson_verified").on(t.hfId, t.companyId, t.verified),
    check("lesson_difficulty_chk", sql`${t.difficulty} BETWEEN 1 AND 5`),
  ],
);

/**
 * One step of a lesson — the unit a student actually reads.
 *
 * `citationIds` is the load-bearing field. A step that teaches a fact must point at the
 * chunks that fact came from, so a student can press "why?" and read the source, and so a
 * reviewer can check the claim without leaving the page. A step with no citation is
 * allowed only for `kind = 'intro'` and `'recap'`, which restate rather than assert —
 * enforced by a CHECK constraint rather than a convention.
 */
export const lessonStep = pgTable(
  "lesson_step",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lesson.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** 'intro' | 'concept' | 'example' | 'check' | 'recap' */
    kind: text("kind").notNull().default("concept"),
    titleLo: text("title_lo"),
    titleEn: text("title_en"),
    /** The teaching text. Lao stays Lao; the English column is a gloss alongside, never
     *  a replacement (CLAUDE.md). Either may be null, but not both — see the CHECK. */
    bodyLo: text("body_lo"),
    bodyEn: text("body_en"),
    /** Typed, data-driven visual spec (contracts `visualSpec`). NOT free-form markup:
     *  a lesson author picks a visual type and supplies its data, and the renderer draws
     *  it. Stored as jsonb, validated by the shared zod schema at both boundaries. */
    visual: jsonb("visual"),
    /** For `kind = 'check'`: the verified QA pair this step quizzes on. Reuses the
     *  existing question bank rather than inventing a parallel one — those pairs are
     *  already human-verified and difficulty-graded. */
    qaPairId: uuid("qa_pair_id").references(() => laoQaPair.id, { onDelete: "set null" }),
    /** Chunks this step's claims rest on. */
    citationIds: uuid("citation_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("lesson_step_seq").on(t.lessonId, t.seq),
    index("lesson_step_lesson").on(t.hfId, t.companyId, t.lessonId, t.seq),
    // A step must say something in at least one language.
    check("lesson_step_body_chk", sql`${t.bodyLo} IS NOT NULL OR ${t.bodyEn} IS NOT NULL`),
    // Asserting steps must cite. intro/recap restate what the lesson already showed.
    //
    // `cardinality`, NOT `array_length`: array_length('{}', 1) is NULL, and a CHECK
    // constraint PASSES when its expression is NULL rather than failing. The first version
    // of this used array_length and silently permitted exactly the uncited step it was
    // written to forbid — caught by the test below it, not by review.
    check(
      "lesson_step_citation_chk",
      sql`${t.kind} IN ('intro','recap') OR cardinality(${t.citationIds}) >= 1`,
    ),
    // A check step is defined by the question it asks.
    check("lesson_step_check_chk", sql`${t.kind} <> 'check' OR ${t.qaPairId} IS NOT NULL`),
  ],
);

/**
 * A student.
 *
 * Deliberately password-less. rag-api has no auth layer and binds loopback because of it
 * (CLAUDE.md), so a password field here would imply a security guarantee the service does
 * not make. This is a name picked on a shared classroom or family device — enough to keep
 * two students' progress apart, and honest about being nothing more.
 */
export const student = pgTable(
  "student",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    displayName: text("display_name").notNull(),
    /** Preferred study language — 'lo' | 'en' | 'both'. Drives which body column is
     *  shown, reusing the answer-language vocabulary from features/lao/lang.ts. */
    lang: text("lang").notNull().default("lo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("student_tenant_name").on(t.hfId, t.companyId, t.displayName)],
);

/** One student's position in one lesson. A row appears when they start it. */
export const lessonProgress = pgTable(
  "lesson_progress",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    lessonId: uuid("lesson_id")
      .notNull()
      .references(() => lesson.id, { onDelete: "cascade" }),
    /** Highest step seq reached. Monotonic — revisiting an earlier step is reading, not
     *  un-learning, so it must never move this backwards. */
    furthestSeq: integer("furthest_seq").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("lesson_progress_student_lesson").on(t.studentId, t.lessonId),
    index("lesson_progress_student").on(t.hfId, t.companyId, t.studentId),
  ],
);

/**
 * One answer to one question, kept forever.
 *
 * Append-only on purpose: the history IS the signal. Spaced repetition needs to know when
 * a question was last seen and how it went, and a weak-topic view needs the pattern of
 * misses, not just the latest verdict. Overwriting would throw away the only data that
 * makes "help them grow" mean anything measurable.
 */
export const quizAttempt = pgTable(
  "quiz_attempt",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    companyId: uuid("company_id").notNull(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => student.id, { onDelete: "cascade" }),
    qaPairId: uuid("qa_pair_id")
      .notNull()
      .references(() => laoQaPair.id, { onDelete: "cascade" }),
    /** The step that asked, when the attempt came from a lesson rather than practice. */
    lessonStepId: uuid("lesson_step_id").references(() => lessonStep.id, {
      onDelete: "set null",
    }),
    correct: boolean("correct").notNull(),
    /** What the student actually chose or typed — kept so a teacher can see the shape of
     *  a misconception, not merely its existence. */
    response: text("response"),
    /** Milliseconds from question shown to answer submitted. */
    elapsedMs: integer("elapsed_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quiz_attempt_student").on(t.hfId, t.companyId, t.studentId, t.createdAt),
    index("quiz_attempt_pair").on(t.hfId, t.companyId, t.qaPairId),
  ],
);
