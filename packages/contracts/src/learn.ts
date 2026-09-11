import { z } from "zod";

/**
 * Lesson contracts — shared web ↔ api.
 *
 * The interesting one is `visualSpec`. A lesson step does not carry markup or an animation
 * script; it carries **typed data plus a visual type**, and the client owns the drawing.
 * Three reasons that boundary sits here:
 *
 *  1. A drafting model can fill in data it has read from a chunk. It cannot be trusted to
 *     emit correct SVG, and un-reviewable markup in the database is markup nobody will
 *     ever audit.
 *  2. The visuals must render offline, in both themes, in Phetsarath OT. That is a client
 *     concern and it changes independently of the content.
 *  3. Every type below is subject-agnostic. `balance` is the accounting equation today and
 *     a chemistry equation tomorrow; `flow` is VAT moving through a sale, or a nitrogen
 *     cycle. The engine does not know what it is teaching, which is the point.
 */

/** A short label + optional value, the atom most visuals are built from. */
export const visualItem = z.object({
  label: z.string().min(1).max(80),
  /** Kept as a STRING. A monetary amount is BIGINT LAK (CLAUDE.md) and a JSON number is a
   *  double — a large kip figure would lose precision on the wire before it was ever drawn. */
  value: z.string().max(60).optional(),
  /** Optional gloss shown beneath the label; Lao stays Lao, English sits alongside. */
  note: z.string().max(160).optional(),
  /** Semantic emphasis, resolved to theme tokens by the renderer — never a raw colour,
   *  which would be unreadable in one of the two themes. */
  tone: z.enum(["neutral", "positive", "negative", "highlight"]).optional(),
});
export type VisualItem = z.infer<typeof visualItem>;

const base = { caption: z.string().max(200).optional() };

/**
 * The visual types a lesson step may declare.
 *
 * Kept deliberately small. Eight general shapes that animate well cover far more teaching
 * than twenty specific ones, and every addition is a renderer a human has to maintain and
 * a shape a drafting model has to choose between correctly.
 */
export const visualSpec = z.discriminatedUnion("type", [
  /** Two sides that must equal each other, settling into balance.
   *  Assets = Liabilities + Equity; reactants = products; income = spending + saving. */
  z.object({
    ...base,
    type: z.literal("balance"),
    leftLabel: z.string().max(80),
    left: z.array(visualItem).min(1).max(6),
    rightLabel: z.string().max(80),
    right: z.array(visualItem).min(1).max(6),
  }),
  /** Ordered stages revealed one at a time — a procedure, a proof, a life cycle. */
  z.object({
    ...base,
    type: z.literal("sequence"),
    steps: z.array(visualItem).min(2).max(8),
  }),
  /** Nodes joined by arrows, animated along the path — VAT through a sale, a supply
   *  chain, a data pipeline. */
  z.object({
    ...base,
    type: z.literal("flow"),
    nodes: z.array(visualItem).min(2).max(6),
    /** Labels for the arrows between consecutive nodes; length = nodes.length - 1. */
    edgeLabels: z.array(z.string().max(40)).max(5).optional(),
  }),
  /** A whole dividing into labelled parts. `value` is the share; the renderer normalises. */
  z.object({
    ...base,
    type: z.literal("parts"),
    wholeLabel: z.string().max(80),
    parts: z
      .array(visualItem.extend({ value: z.string().max(60) }))
      .min(2)
      .max(8),
  }),
  /** Two or more things side by side, differences emphasised. */
  z.object({
    ...base,
    type: z.literal("compare"),
    columns: z
      .array(z.object({ heading: z.string().max(60), items: z.array(visualItem).min(1).max(6) }))
      .min(2)
      .max(3),
  }),
  /** Events along an axis — a period close, a reign, a reaction over time. */
  z.object({
    ...base,
    type: z.literal("timeline"),
    events: z.array(visualItem).min(2).max(8),
  }),
  /** An expression assembling term by term, then substituted with real values. */
  z.object({
    ...base,
    type: z.literal("formula"),
    /** Written plainly, not TeX: no maths typesetter may be loaded (offline-only CSP),
     *  and a Lao-labelled formula is read, not typeset. */
    expression: z.string().min(1).max(200),
    /** Each term explained, revealed as the expression assembles. */
    terms: z.array(visualItem).min(1).max(6),
    /** Optional worked substitution, e.g. "20,000,000 × 10 / 100 = 2,000,000". */
    substitution: z.string().max(200).optional(),
  }),
  /** A small table with cells highlighted in sequence — the shape that most often defeats
   *  plain prose, and the chunk kind this corpus retrieves worst. */
  z.object({
    ...base,
    type: z.literal("table"),
    headers: z.array(z.string().max(40)).min(2).max(5),
    rows: z
      .array(z.array(z.string().max(80)).min(2).max(5))
      .min(1)
      .max(10),
    /** Row indices to emphasise, in reveal order. */
    highlightRows: z.array(z.number().int().min(0)).max(10).optional(),
  }),
]);
export type VisualSpec = z.infer<typeof visualSpec>;

export const lessonStepKind = z.enum(["intro", "concept", "example", "check", "recap"]);
export type LessonStepKind = z.infer<typeof lessonStepKind>;

export const lessonStep = z.object({
  id: z.string(),
  seq: z.number().int().min(0),
  kind: lessonStepKind,
  titleLo: z.string().nullable(),
  titleEn: z.string().nullable(),
  bodyLo: z.string().nullable(),
  bodyEn: z.string().nullable(),
  /** null when the step needs no picture — most `check` steps do not. */
  visual: visualSpec.nullable(),
  qaPairId: z.string().nullable(),
  citationIds: z.array(z.string()),
});
export type LessonStep = z.infer<typeof lessonStep>;

export const lessonSummary = z.object({
  id: z.string(),
  subjectId: z.string(),
  titleLo: z.string(),
  titleEn: z.string().nullable(),
  summaryLo: z.string().nullable(),
  summaryEn: z.string().nullable(),
  difficulty: z.number().int().min(1).max(5),
  estimatedMinutes: z.number().int().min(1),
  seq: z.number().int(),
  prerequisiteIds: z.array(z.string()),
  tags: z.array(z.string()),
  source: z.string(),
  verified: z.boolean(),
  stepCount: z.number().int().min(0),
});
export type LessonSummary = z.infer<typeof lessonSummary>;

export const lessonDetail = lessonSummary.extend({ steps: z.array(lessonStep) });
export type LessonDetail = z.infer<typeof lessonDetail>;

export const subject = z.object({
  id: z.string(),
  key: z.string(),
  nameLo: z.string(),
  nameEn: z.string().nullable(),
  descriptionLo: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  collections: z.array(z.string()),
  seq: z.number().int(),
  /** Verified lessons only — an unverified draft is invisible to a student and must not
   *  inflate the count they see on a subject card. */
  lessonCount: z.number().int().min(0),
});
export type Subject = z.infer<typeof subject>;

export const student = z.object({
  id: z.string(),
  displayName: z.string(),
  lang: z.enum(["lo", "en", "both"]),
});
export type Student = z.infer<typeof student>;

export const lessonProgress = z.object({
  lessonId: z.string(),
  furthestSeq: z.number().int().min(0),
  completedAt: z.string().nullable(),
  startedAt: z.string(),
});
export type LessonProgress = z.infer<typeof lessonProgress>;

/** A drafting request: turn chunks into lesson steps for review. */
export const lessonDraftRequest = z.object({
  subjectId: z.string(),
  /** Free-text topic. The chunks are retrieved for it, so this is also the search query. */
  topic: z.string().min(2).max(200),
  /** How many steps to aim for. A lesson longer than this stops being one lesson. */
  targetSteps: z.number().int().min(3).max(12).optional(),
  model: z.string().optional(),
});
export type LessonDraftRequest = z.infer<typeof lessonDraftRequest>;
