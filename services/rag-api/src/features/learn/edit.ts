import type { VisualSpec } from "@arnfar/contracts";
import { visualSpec } from "@arnfar/contracts";
import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { fixLaoTypography, restoreInitialismSpacing } from "../lao/clean.ts";

/**
 * Curator editing for lessons and their steps.
 *
 * **Every edit un-verifies the lesson.** This follows `updateQa`, and for the same reason:
 * approval is a statement about specific text, so changing the text withdraws it. Without
 * that rule a curator could approve a lesson, then edit a rate inside it, and the new
 * number would reach students carrying an approval nobody gave it.
 *
 * The database's CHECK constraints stay the final authority — an asserting step must cite,
 * a check step must have a question, a step must say something in some language. This
 * module's job is to fail those cases at the boundary with a sentence a curator can act
 * on, rather than letting a constraint name reach the UI.
 */

export class EditError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "EditError";
  }
}

const ASSERTING_KINDS = new Set(["concept", "example", "check"]);
const ALL_KINDS = new Set(["intro", "concept", "example", "check", "recap"]);

/** The same deterministic Lao repair the drafter applies. A curator's own typing gets it
 *  too: the rule is about what a student reads, not about who wrote it. */
function repairLao(text: string): string {
  return restoreInitialismSpacing(fixLaoTypography(text));
}

function tenantEq(t: TenantContext, table: { hfId: unknown; companyId: unknown }) {
  return and(eq(table.hfId as never, t.hfId), eq(table.companyId as never, t.companyId));
}

/** Withdraw approval. Called by every mutation here — see the module note. */
async function unverify(tenant: TenantContext, lessonId: string): Promise<void> {
  await db()
    .update(schema.lesson)
    .set({ verified: false, verifiedBy: null, verifiedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.lesson.id, lessonId), tenantEq(tenant, schema.lesson)));
}

/** The step, plus the lesson it belongs to — every mutation needs both. */
async function loadStep(tenant: TenantContext, stepId: string) {
  const rows = await db()
    .select()
    .from(schema.lessonStep)
    .where(and(eq(schema.lessonStep.id, stepId), tenantEq(tenant, schema.lessonStep)))
    .limit(1);
  const step = rows[0];
  if (!step) throw new EditError("step not found", 404);
  return step;
}

/**
 * Citations must reference real, non-rejected chunks of this tenant.
 *
 * Checked here rather than left to a foreign key, because there is none: `citation_ids` is
 * a uuid array. A lesson citing a chunk a reviewer threw out is the same defect as an
 * export containing one.
 */
async function validateCitations(tenant: TenantContext, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db()
    .select({ id: schema.ragChunk.id })
    .from(schema.ragChunk)
    .where(
      and(
        inArray(schema.ragChunk.id, ids),
        tenantEq(tenant, schema.ragChunk),
        ne(schema.ragChunk.review, "rejected"),
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new EditError(
      `these citations do not point at a usable chunk (missing, other tenant, or rejected): ${missing.join(", ")}`,
      422,
    );
  }
}

function parseVisual(raw: unknown): VisualSpec | null {
  if (raw === null) return null;
  const parsed = visualSpec.safeParse(raw);
  if (!parsed.success) {
    // The first issue is the useful one; a full zod dump is unreadable in a toast.
    const issue = parsed.error.issues[0];
    throw new EditError(
      `that visual is not valid: ${issue ? `${issue.path.join(".") || "(root)"} — ${issue.message}` : "unknown shape"}`,
      422,
    );
  }
  return parsed.data;
}

// ── Lesson metadata ─────────────────────────────────────────────────────────────────

export interface LessonPatch {
  titleLo?: string;
  titleEn?: string | null;
  summaryLo?: string | null;
  summaryEn?: string | null;
  difficulty?: number;
  estimatedMinutes?: number;
}

export async function updateLesson(
  tenant: TenantContext,
  id: string,
  patch: LessonPatch,
): Promise<{ id: string }> {
  const set: Record<string, unknown> = {};
  if (patch.titleLo !== undefined) {
    const title = patch.titleLo.trim();
    if (!title) throw new EditError("a lesson needs a title", 422);
    set.titleLo = repairLao(title);
  }
  if (patch.titleEn !== undefined) set.titleEn = patch.titleEn?.trim() || null;
  if (patch.summaryLo !== undefined) {
    set.summaryLo = patch.summaryLo?.trim() ? repairLao(patch.summaryLo.trim()) : null;
  }
  if (patch.summaryEn !== undefined) set.summaryEn = patch.summaryEn?.trim() || null;
  if (patch.difficulty !== undefined) {
    if (patch.difficulty < 1 || patch.difficulty > 5) {
      throw new EditError("difficulty is 1 to 5", 422);
    }
    set.difficulty = patch.difficulty;
  }
  if (patch.estimatedMinutes !== undefined) {
    if (patch.estimatedMinutes < 1 || patch.estimatedMinutes > 120) {
      throw new EditError("estimated minutes is 1 to 120", 422);
    }
    set.estimatedMinutes = patch.estimatedMinutes;
  }
  if (!Object.keys(set).length) throw new EditError("nothing to change", 422);

  // Editing withdraws approval — the same rule updateQa applies to a QA pair.
  set.verified = false;
  set.verifiedBy = null;
  set.verifiedAt = null;
  set.updatedAt = new Date();

  const rows = await db()
    .update(schema.lesson)
    .set(set)
    .where(and(eq(schema.lesson.id, id), tenantEq(tenant, schema.lesson)))
    .returning({ id: schema.lesson.id });
  const row = rows[0];
  if (!row) throw new EditError("lesson not found", 404);
  return row;
}

// ── Steps ───────────────────────────────────────────────────────────────────────────

export interface StepPatch {
  kind?: string;
  titleLo?: string | null;
  titleEn?: string | null;
  bodyLo?: string | null;
  bodyEn?: string | null;
  /** `null` removes the visual; an object replaces it; omitted leaves it alone. */
  visual?: unknown;
  citationIds?: string[];
  qaPairId?: string | null;
}

export async function updateStep(
  tenant: TenantContext,
  stepId: string,
  patch: StepPatch,
): Promise<{ id: string; lessonId: string }> {
  const step = await loadStep(tenant, stepId);

  // Resolve the post-edit values first, so the invariants below are checked against what
  // the row WILL be — not against a mix of old and new that no version ever holds.
  const kind = patch.kind ?? step.kind;
  if (!ALL_KINDS.has(kind)) {
    throw new EditError(`unknown step kind "${kind}"`, 422);
  }
  const bodyLo = patch.bodyLo !== undefined ? patch.bodyLo?.trim() || null : step.bodyLo;
  const bodyEn = patch.bodyEn !== undefined ? patch.bodyEn?.trim() || null : step.bodyEn;
  const citationIds = patch.citationIds ?? step.citationIds;
  const qaPairId = patch.qaPairId !== undefined ? patch.qaPairId : step.qaPairId;

  if (!bodyLo && !bodyEn) {
    throw new EditError("a step must say something in Lao or English", 422);
  }
  if (ASSERTING_KINDS.has(kind) && citationIds.length === 0) {
    throw new EditError(
      `a "${kind}" step teaches a fact, so it must cite at least one source. Only "intro" and "recap" may go uncited.`,
      422,
    );
  }
  if (kind === "check" && !qaPairId) {
    throw new EditError('a "check" step needs a question from the verified bank', 422);
  }
  if (patch.citationIds !== undefined) await validateCitations(tenant, citationIds);

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.kind !== undefined) set.kind = kind;
  if (patch.titleLo !== undefined) {
    set.titleLo = patch.titleLo?.trim() ? repairLao(patch.titleLo.trim()) : null;
  }
  if (patch.titleEn !== undefined) set.titleEn = patch.titleEn?.trim() || null;
  if (patch.bodyLo !== undefined) set.bodyLo = bodyLo ? repairLao(bodyLo) : null;
  if (patch.bodyEn !== undefined) set.bodyEn = bodyEn;
  if (patch.visual !== undefined) set.visual = parseVisual(patch.visual);
  if (patch.citationIds !== undefined) set.citationIds = citationIds;
  if (patch.qaPairId !== undefined) set.qaPairId = qaPairId;

  await db().update(schema.lessonStep).set(set).where(eq(schema.lessonStep.id, stepId));
  await unverify(tenant, step.lessonId);
  return { id: stepId, lessonId: step.lessonId };
}

export async function addStep(
  tenant: TenantContext,
  lessonId: string,
  input: { kind?: string; bodyLo?: string; bodyEn?: string; citationIds?: string[] },
): Promise<{ id: string }> {
  const lessonRows = await db()
    .select({ id: schema.lesson.id })
    .from(schema.lesson)
    .where(and(eq(schema.lesson.id, lessonId), tenantEq(tenant, schema.lesson)))
    .limit(1);
  if (!lessonRows[0]) throw new EditError("lesson not found", 404);

  const kind = input.kind ?? "concept";
  if (!ALL_KINDS.has(kind)) throw new EditError(`unknown step kind "${kind}"`, 422);
  const bodyLo = input.bodyLo?.trim() || null;
  const bodyEn = input.bodyEn?.trim() || null;
  if (!bodyLo && !bodyEn) throw new EditError("a step must say something", 422);
  const citationIds = input.citationIds ?? [];
  if (ASSERTING_KINDS.has(kind) && citationIds.length === 0) {
    throw new EditError(`a "${kind}" step must cite at least one source`, 422);
  }
  await validateCitations(tenant, citationIds);

  // Appended at the end. `max(seq) + 1` rather than a count, so a lesson whose steps were
  // renumbered by a delete still gets a free slot.
  const maxRows = await db()
    .select({ max: sql<number>`COALESCE(MAX(${schema.lessonStep.seq}), -1)` })
    .from(schema.lessonStep)
    .where(eq(schema.lessonStep.lessonId, lessonId));
  const nextSeq = Number(maxRows[0]?.max ?? -1) + 1;

  const id = newId();
  await db()
    .insert(schema.lessonStep)
    .values({
      id,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      lessonId,
      seq: nextSeq,
      kind,
      bodyLo: bodyLo ? repairLao(bodyLo) : null,
      bodyEn,
      citationIds,
    });
  await unverify(tenant, lessonId);
  return { id };
}

export async function deleteStep(tenant: TenantContext, stepId: string): Promise<void> {
  const step = await loadStep(tenant, stepId);

  await db().transaction(async (tx) => {
    await tx.delete(schema.lessonStep).where(eq(schema.lessonStep.id, stepId));
    // Close the gap. Ascending order is required, not incidental: (lesson_id, seq) is
    // UNIQUE, and each row moves into the slot the previous one just vacated. Descending
    // would collide on the first move.
    const after = await tx
      .select({ id: schema.lessonStep.id, seq: schema.lessonStep.seq })
      .from(schema.lessonStep)
      .where(
        and(eq(schema.lessonStep.lessonId, step.lessonId), gt(schema.lessonStep.seq, step.seq)),
      )
      .orderBy(asc(schema.lessonStep.seq));
    for (const row of after) {
      await tx
        .update(schema.lessonStep)
        .set({ seq: row.seq - 1 })
        .where(eq(schema.lessonStep.id, row.id));
    }
  });
  await unverify(tenant, step.lessonId);
}

/**
 * Swap a step with its neighbour.
 *
 * Three writes, not two: (lesson_id, seq) is UNIQUE, so assigning the neighbour's seq
 * directly collides mid-transaction. The step is parked on a negative seq first — a value
 * no real step holds, and one the unique index tolerates because only one row is ever
 * there at a time.
 */
export async function moveStep(
  tenant: TenantContext,
  stepId: string,
  direction: "up" | "down",
): Promise<void> {
  const step = await loadStep(tenant, stepId);
  const targetSeq = direction === "up" ? step.seq - 1 : step.seq + 1;
  if (targetSeq < 0) return; // already first — a no-op, not an error

  const neighbourRows = await db()
    .select({ id: schema.lessonStep.id, seq: schema.lessonStep.seq })
    .from(schema.lessonStep)
    .where(and(eq(schema.lessonStep.lessonId, step.lessonId), eq(schema.lessonStep.seq, targetSeq)))
    .limit(1);
  const neighbour = neighbourRows[0];
  if (!neighbour) return; // already last

  await db().transaction(async (tx) => {
    await tx.update(schema.lessonStep).set({ seq: -1 }).where(eq(schema.lessonStep.id, step.id));
    await tx
      .update(schema.lessonStep)
      .set({ seq: step.seq })
      .where(eq(schema.lessonStep.id, neighbour.id));
    await tx
      .update(schema.lessonStep)
      .set({ seq: neighbour.seq })
      .where(eq(schema.lessonStep.id, step.id));
  });
  await unverify(tenant, step.lessonId);
}
