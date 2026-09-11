import type { VisualSpec } from "@arnfar/contracts";
import { visualSpec } from "@arnfar/contracts";
import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";
import { generate } from "../../lib/ollama.ts";
import { LAO_WRITING_RULES } from "../chat/prompt.ts";
import { fixLaoTypography, restoreInitialismSpacing } from "../lao/clean.ts";
import { search } from "../search/service.ts";

const dlog = log.child("lesson-draft");

/**
 * Draft a lesson from the corpus — the tutor's equivalent of QA drafting.
 *
 * Two rules shape the whole design:
 *
 *  1. **The model writes prose, never facts it invented.** It is given numbered chunks and
 *     told to teach only from them, and every asserting step must name the numbers it used.
 *     A step whose citations do not resolve is dropped rather than saved uncited — the
 *     `lesson_step_citation_chk` constraint would refuse it anyway, and failing at the
 *     boundary gives a better message than a constraint violation.
 *  2. **Check questions are NOT written by the model.** They are pulled from
 *     `lao_qa_pair` where `verified = true` and the citations overlap this lesson's chunks.
 *     There is already a human-verified, difficulty-graded question bank; generating a
 *     parallel unverified one would be strictly worse and would need its own review queue.
 *
 * The result is always `verified = false`. Drafting proposes; a curator disposes.
 */

const MAX_CHUNKS = 8;
const CHUNK_CHARS = 900;

interface DraftedStep {
  kind?: string;
  titleLo?: string;
  titleEn?: string;
  bodyLo?: string;
  bodyEn?: string;
  cites?: number[];
  visual?: unknown;
}

interface DraftedLesson {
  titleLo?: string;
  titleEn?: string;
  summaryLo?: string;
  summaryEn?: string;
  difficulty?: number;
  estimatedMinutes?: number;
  steps?: DraftedStep[];
}

const SYSTEM = [
  "You write short lessons for students, from supplied source extracts ONLY.",
  "Rules:",
  // Shared with the chat path. A drafter that writes Lao needs the same orthography rules
  // the answer path needs — its first output was `ຂອງVATຢູ່ສປປ. ລາວແມ່ນ10%` without them.
  ...LAO_WRITING_RULES,
  "- Teach ONLY what the numbered sources say. Never add a fact, figure, rate or date that is not in them.",
  "- Every concept/example step must list the source numbers it used in `cites`.",
  "- Write bodyLo in Lao and bodyEn in English. Lao stays Lao — the English is a parallel version, never a replacement, and both must state the same facts.",
  "- Keep each step short: two to four sentences. A step is one idea.",
  "- Copy numbers, rates, dates and codes EXACTLY as the sources give them.",
  "- Output JSON only.",
].join("\n");

/** The visual vocabulary, described for the drafter. Kept in sync with contracts
 *  `visualSpec` by the zod parse below: a type this list gets wrong simply fails to
 *  validate and the step keeps its text without a picture. */
const VISUAL_GUIDE = [
  "Each step MAY carry a `visual`: choose ONE type below and supply its data.",
  'balance:  {"type":"balance","leftLabel":"...","left":[{"label":"..","value":".."}],"rightLabel":"...","right":[...]}',
  'sequence: {"type":"sequence","steps":[{"label":"..","note":".."}, ...]}   (2-8)',
  'flow:     {"type":"flow","nodes":[{"label":".."}, ...],"edgeLabels":["..",".."]}',
  'parts:    {"type":"parts","wholeLabel":"..","parts":[{"label":"..","value":".."}, ...]}',
  'compare:  {"type":"compare","columns":[{"heading":"..","items":[{"label":".."}]}, ...]}',
  'timeline: {"type":"timeline","events":[{"label":"..","note":".."}, ...]}',
  'formula:  {"type":"formula","expression":"..","terms":[{"label":".."}],"substitution":".."}',
  'table:    {"type":"table","headers":["..",".."],"rows":[["..",".."]]}',
  "Every `value` is a STRING. Use a visual only when it shows something the words cannot.",
].join("\n");

export interface DraftParams {
  tenant: TenantContext;
  subjectId: string;
  topic: string;
  targetSteps?: number;
  model?: string;
}

export interface DraftResult {
  lessonId: string;
  titleLo: string;
  stepCount: number;
  checkSteps: number;
  sourcesUsed: number;
  droppedSteps: number;
}

export class DraftError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

/** Verified QA pairs whose citations overlap this lesson's chunks — the check questions.
 *  Ordered easiest first, so a lesson's checks build up rather than opening on the hardest. */
async function checksFor(tenant: TenantContext, chunkIds: string[], limit: number) {
  if (!chunkIds.length || limit <= 0) return [];
  return db()
    .select({
      id: schema.laoQaPair.id,
      difficulty: schema.laoQaPair.difficulty,
      questionLo: schema.laoQaPair.questionLo,
      citationIds: schema.laoQaPair.citationIds,
    })
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
        eq(schema.laoQaPair.verified, true),
        // Overlap operator: the pair cites at least one chunk this lesson teaches from.
        // The array is built with sql.join rather than interpolated whole: a bare JS
        // array inside a raw template is emitted as a record, and Postgres refuses to
        // cast a record to uuid[].
        sql`${schema.laoQaPair.citationIds} && ARRAY[${sql.join(
          chunkIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`,
      ),
    )
    .orderBy(schema.laoQaPair.difficulty)
    .limit(limit);
}

/** Deterministic, offline Lao repair applied to every generated string a student reads:
 *  punctuation whitespace, then the closed list of protected initialisms. It cannot insert
 *  a space the model never wrote — that is what the prompt rules are for — but it fixes
 *  what is mechanically decidable. */
function repairLao(text: string): string {
  return restoreInitialismSpacing(fixLaoTypography(text));
}

function parseVisual(raw: unknown): VisualSpec | null {
  if (raw === null || raw === undefined) return null;
  const parsed = visualSpec.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

export async function draftLesson(p: DraftParams): Promise<DraftResult> {
  const subjectRows = await db()
    .select()
    .from(schema.subject)
    .where(
      and(
        eq(schema.subject.id, p.subjectId),
        eq(schema.subject.hfId, p.tenant.hfId),
        eq(schema.subject.companyId, p.tenant.companyId),
      ),
    )
    .limit(1);
  const subject = subjectRows[0];
  if (!subject) throw new DraftError(`unknown subject: ${p.subjectId}`, 404);

  // Retrieve through the production retriever, scoped to the subject's collections. The
  // lesson can therefore only be built from material this tenant actually has.
  const retrieval = await search({
    query: p.topic,
    collections: subject.collections,
    k: MAX_CHUNKS,
    tenant: p.tenant,
  });
  if (!retrieval.hits.length) {
    throw new DraftError(
      `no sources found for "${p.topic}" in subject "${subject.key}" — ingest material for ` +
        "this topic first, or widen the subject's collections",
      422,
    );
  }

  const sources = retrieval.hits.map((h, i) => ({
    n: i + 1,
    id: h.id,
    title: h.title,
    heading: h.heading_path.join(" › "),
    text: h.content.slice(0, CHUNK_CHARS),
  }));
  const chunkIds = sources.map((s) => s.id);

  const target = p.targetSteps ?? 6;
  const sourceBlock = sources
    .map((s) => `[${s.n}] ${s.title}${s.heading ? ` — ${s.heading}` : ""}\n${s.text}`)
    .join("\n\n");

  const prompt = [
    VISUAL_GUIDE,
    "",
    `Sources:\n${sourceBlock}`,
    "",
    `Write a lesson teaching: ${p.topic}`,
    `Aim for ${target} steps. Use kinds: "intro" first, then "concept" and "example", "recap" last.`,
    'Do NOT write any step of kind "check" — quiz questions are added separately.',
    "",
    "JSON shape:",
    '{"titleLo":"..","titleEn":"..","summaryLo":"..","summaryEn":"..","difficulty":1-5,' +
      '"estimatedMinutes":5-40,"steps":[{"kind":"concept","titleLo":"..","titleEn":"..",' +
      '"bodyLo":"..","bodyEn":"..","cites":[1,3],"visual":{...}}]}',
  ].join("\n");

  const raw = await generate(prompt, {
    system: SYSTEM,
    json: true,
    temperature: 0.3,
    maxTokens: 2400,
    ...(p.model ? { model: p.model } : {}),
  });

  let drafted: DraftedLesson;
  try {
    drafted = JSON.parse(raw) as DraftedLesson;
  } catch {
    throw new DraftError(`the drafting model did not return JSON: ${raw.slice(0, 160)}`, 502);
  }

  const titleLo = repairLao((drafted.titleLo ?? p.topic).trim()).slice(0, 200);
  const steps = Array.isArray(drafted.steps) ? drafted.steps : [];
  if (!steps.length) throw new DraftError("the drafting model returned no steps", 502);

  const lessonId = newId();
  const now = new Date();

  // Build the step rows, dropping any that cannot satisfy the citation rule.
  const KINDS = new Set(["intro", "concept", "example", "recap"]);
  const rows: (typeof schema.lessonStep.$inferInsert)[] = [];
  let dropped = 0;
  let seq = 0;

  for (const s of steps) {
    const kind = KINDS.has(s.kind ?? "") ? (s.kind as string) : "concept";
    const bodyLo = s.bodyLo?.trim() || null;
    const bodyEn = s.bodyEn?.trim() || null;
    if (!bodyLo && !bodyEn) {
      dropped++;
      continue;
    }
    // Map the model's source numbers back to real chunk ids. It never sees an id, so it
    // cannot invent one — an out-of-range number simply resolves to nothing.
    const cites = Array.isArray(s.cites) ? s.cites : [];
    const citationIds = [
      ...new Set(
        cites
          .map((n) => sources.find((src) => src.n === n)?.id)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    // intro and recap restate; everything else must cite (mirrors the CHECK constraint).
    if (!["intro", "recap"].includes(kind) && citationIds.length === 0) {
      dropped++;
      continue;
    }
    rows.push({
      id: newId(),
      hfId: p.tenant.hfId,
      companyId: p.tenant.companyId,
      lessonId,
      seq: seq++,
      kind,
      // Titles get the SAME repair as bodies. Missed on the first pass, and a step
      // rendered `ຜູ້ຂຶ້ນທະບຽນVAT` as its heading — the most prominent text on the screen
      // was the one line not being cleaned.
      titleLo: s.titleLo?.trim() ? repairLao(s.titleLo.trim()) : null,
      titleEn: s.titleEn?.trim() || null,
      bodyLo: bodyLo ? repairLao(bodyLo) : null,
      bodyEn,
      visual: parseVisual(s.visual),
      qaPairId: null,
      citationIds,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!rows.length) {
    throw new DraftError(
      "every drafted step was dropped: none cited a source. Re-run, or ingest clearer " +
        "material for this topic.",
      422,
    );
  }

  // Check steps from the verified bank, appended before the recap if there is one.
  const checks = await checksFor(p.tenant, chunkIds, 3);
  const recapAt = rows.findIndex((r) => r.kind === "recap");
  const checkRows = checks.map((c) => ({
    id: newId(),
    hfId: p.tenant.hfId,
    companyId: p.tenant.companyId,
    lessonId,
    seq: 0, // re-numbered below
    kind: "check",
    titleLo: null,
    titleEn: null,
    bodyLo: c.questionLo,
    bodyEn: null,
    visual: null,
    qaPairId: c.id,
    // A check step inherits the question's own citations, so "why?" works from it too.
    citationIds: c.citationIds,
    createdAt: now,
    updatedAt: now,
  }));

  const ordered =
    recapAt >= 0
      ? [...rows.slice(0, recapAt), ...checkRows, ...rows.slice(recapAt)]
      : [...rows, ...checkRows];
  ordered.forEach((r, i) => {
    r.seq = i;
  });

  await db().transaction(async (tx) => {
    await tx.insert(schema.lesson).values({
      id: lessonId,
      hfId: p.tenant.hfId,
      companyId: p.tenant.companyId,
      subjectId: p.subjectId,
      titleLo,
      titleEn: drafted.titleEn?.trim() || null,
      summaryLo: drafted.summaryLo?.trim() ? repairLao(drafted.summaryLo.trim()) : null,
      summaryEn: drafted.summaryEn?.trim() || null,
      difficulty: Math.max(1, Math.min(5, Number(drafted.difficulty) || 2)),
      estimatedMinutes: Math.max(1, Math.min(120, Number(drafted.estimatedMinutes) || 10)),
      seq: 0,
      source: "llm_draft",
      verified: false,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(schema.lessonStep).values(ordered);
  });

  dlog.info("drafted lesson", {
    lessonId,
    topic: p.topic,
    steps: ordered.length,
    checks: checkRows.length,
    dropped,
  });

  return {
    lessonId,
    titleLo,
    stepCount: ordered.length,
    checkSteps: checkRows.length,
    sourcesUsed: chunkIds.length,
    droppedSteps: dropped,
  };
}
