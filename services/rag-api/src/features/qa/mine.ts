import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";
import { detectLanguage } from "../lao/lang.ts";

const mlog = log.child("qa-mine");

/**
 * Harvest dataset candidates out of conversation history — the flywheel.
 *
 * `/chat/promote` already exists, but it needs a curator to notice a good answer and click.
 * Most good answers are never clicked, so the questions real users actually ask stay
 * outside the dataset and the eval set keeps describing questions nobody asked.
 *
 * This walks the history instead and proposes. Every mined row lands `verified = false`
 * with `source = 'chat_mined'`: it is a *candidate*, and CLAUDE.md is explicit that
 * extraction proposes and a person disposes. Nothing mined can export, because export
 * takes `verified = true` rows only.
 *
 * What is deliberately NOT done here: no model call. Mining is a join plus a filter over
 * turns that already happened. Asking a generator to rewrite the pair would put an
 * unreviewed model opinion into the dataset's provenance chain, and the whole point of the
 * `chat_mined` label is that the text is exactly what was said.
 */

/** An answer shorter than this is an acknowledgement, not accounting content. */
const MIN_ANSWER_CHARS = 60;
/** A question shorter than this is a greeting or a test poke, not a question worth
 *  putting in front of a curator. Found the hard way: a first mining pass over real
 *  history proposed "HI" as a dataset candidate, complete with eight citations — the
 *  retriever will always return *something*, so answer quality cannot vouch for the
 *  question. Lao is dense (≈1 char per syllable), so this is short by design. */
const MIN_QUESTION_CHARS = 12;
/** A question longer than this is a pasted document, not a question. */
const MAX_QUESTION_CHARS = 400;
/** Ceiling per pass, so a long history cannot produce an unreviewable queue in one click. */
const DEFAULT_LIMIT = 50;

export interface MineCandidate {
  messageId: string;
  conversationId: string;
  question: string;
  answer: string;
  citationIds: string[];
  lang: "lo" | "en" | "mixed";
  at: string;
}

export interface MineResult {
  scanned: number;
  created: number;
  skipped: {
    alreadyMined: number;
    duplicateQuestion: number;
    noCitations: number;
    tooShort: number;
  };
  candidates: MineCandidate[];
}

interface TurnRow {
  message_id: string;
  conversation_id: string;
  answer: string;
  sources: unknown;
  created_at: string | Date;
  question: string | null;
  [key: string]: unknown;
}

/** Citation ids the answer actually rests on.
 *
 *  Filtered POSITIVELY to `origin === "dataset"`: only those carry a real `rag_chunk.id`.
 *  A web source's id is the synthetic `web:<url>`, and ERP and calc sources are built at
 *  prompt time with no chunk behind them at all — none can satisfy the export rule that
 *  every citation reference a real, non-rejected chunk. Denying the known-bad origins
 *  instead would silently admit any origin added later. */
function datasetCitationIds(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const ids: string[] = [];
  for (const s of sources) {
    if (typeof s !== "object" || s === null) continue;
    const row = s as { id?: unknown; origin?: unknown };
    if (row.origin !== "dataset") continue;
    if (typeof row.id === "string" && row.id.length > 0) ids.push(row.id);
  }
  return [...new Set(ids)];
}

/** Normalised question text, for duplicate detection. Whitespace and case only — no
 *  stemming, because two Lao questions that differ by one word are genuinely two
 *  questions and the dataset wants the phrasing variety. */
function questionKey(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Scan assistant turns and create unverified QA candidates from the good ones.
 *
 * A turn qualifies when it cited at least one dataset chunk, gave a substantive answer,
 * and its question is not already in the dataset. `dryRun` returns exactly what would be
 * created without writing — the Studio uses it to show the queue before committing.
 */
export async function mineConversations(
  tenant: TenantContext,
  opts: { limit?: number; dryRun?: boolean; collection?: string } = {},
): Promise<MineResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, 200);

  // Assistant turns with their preceding user question, newest first. The correlated
  // subquery is the same shape dashboard.gaps() uses to pair a turn with its question.
  const rows = (await db().execute(sql`
    SELECT m.id AS message_id, m.conversation_id, m.content AS answer, m.sources,
           m.created_at,
           (SELECT u.content FROM rag_message u
             WHERE u.conversation_id = m.conversation_id
               AND u.role = 'user' AND u.created_at < m.created_at
             ORDER BY u.created_at DESC LIMIT 1) AS question
    FROM rag_message m
    WHERE m.hf_id = ${tenant.hfId} AND m.company_id = ${tenant.companyId}
      AND m.role = 'assistant'
      AND m.sources IS NOT NULL
      AND COALESCE(m.meta ->> 'mined', 'false') <> 'true'
    ORDER BY m.created_at DESC
    LIMIT ${limit * 3}
  `)) as unknown as TurnRow[];

  const skipped = { alreadyMined: 0, duplicateQuestion: 0, noCitations: 0, tooShort: 0 };

  // Every question already in the dataset, however it got there. Mining must not
  // re-propose a pair a curator has already written, verified, or rejected the text of.
  const existing = await db()
    .select({ questionLo: schema.laoQaPair.questionLo, questionEn: schema.laoQaPair.questionEn })
    .from(schema.laoQaPair)
    .where(
      and(eq(schema.laoQaPair.hfId, tenant.hfId), eq(schema.laoQaPair.companyId, tenant.companyId)),
    );
  const seen = new Set<string>();
  for (const e of existing) {
    seen.add(questionKey(e.questionLo));
    if (e.questionEn) seen.add(questionKey(e.questionEn));
  }

  const candidates: MineCandidate[] = [];
  const minedMessageIds: string[] = [];

  for (const r of rows) {
    if (candidates.length >= limit) break;
    const question = r.question?.trim() ?? "";
    const answer = r.answer?.trim() ?? "";
    if (
      question.length < MIN_QUESTION_CHARS ||
      question.length > MAX_QUESTION_CHARS ||
      answer.length < MIN_ANSWER_CHARS
    ) {
      skipped.tooShort++;
      continue;
    }
    const citationIds = datasetCitationIds(r.sources);
    if (citationIds.length === 0) {
      // An uncited pair can never export (CLAUDE.md), so proposing one only adds noise
      // to the review queue. The turn is still a signal — it lands in the gaps list.
      skipped.noCitations++;
      continue;
    }
    const key = questionKey(question);
    if (seen.has(key)) {
      skipped.duplicateQuestion++;
      continue;
    }
    seen.add(key);

    candidates.push({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      question,
      answer,
      citationIds,
      lang: detectLanguage(question),
      at: new Date(r.created_at).toISOString(),
    });
    minedMessageIds.push(r.message_id);
  }

  if (opts.dryRun || candidates.length === 0) {
    return { scanned: rows.length, created: 0, skipped, candidates };
  }

  // The chunk each pair is filed under, so the row lands in the same collection as the
  // evidence rather than a hardcoded default.
  const firstChunks = candidates.map((c) => c.citationIds[0]!).filter(Boolean);
  const chunkRows = firstChunks.length
    ? await db()
        .select({ id: schema.ragChunk.id, collection: schema.ragChunk.collection })
        .from(schema.ragChunk)
        .where(inArray(schema.ragChunk.id, firstChunks))
    : [];
  const collectionOf = new Map(chunkRows.map((c) => [c.id, c.collection]));

  const now = new Date();
  const values = candidates.map((c) => {
    // The question's own language decides which column it lands in. A Lao question is
    // never machine-translated to fill question_en, and an English one is never
    // transliterated into question_lo — the empty column stays empty until a human
    // writes the other side. question_lo is NOT NULL, so an English-only pair carries
    // its English text there too and the curator moves it; recorded in tags so that is
    // visible rather than a silent mismatch.
    const isEn = c.lang === "en";
    return {
      id: newId(),
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      collection: opts.collection ?? collectionOf.get(c.citationIds[0]!) ?? "chat",
      questionLo: c.question,
      ...(isEn ? { questionEn: c.question } : {}),
      answerLo: c.answer,
      ...(isEn ? { answerEn: c.answer } : {}),
      citationIds: c.citationIds,
      source: "chat_mined" as const,
      split: "unassigned" as const,
      verified: false,
      tags: isEn ? ["mined", "lang:en"] : ["mined", `lang:${c.lang}`],
      createdAt: now,
      updatedAt: now,
    };
  });

  await db().insert(schema.laoQaPair).values(values);

  // Mark the turns so a second pass does not re-propose them. Written after the insert:
  // if the insert fails, the turns stay unmined and the next run retries them, which is
  // the safe direction to be wrong in.
  await db()
    .update(schema.ragMessage)
    .set({ meta: sql`${schema.ragMessage.meta} || '{"mined":true}'::jsonb` })
    .where(inArray(schema.ragMessage.id, minedMessageIds));

  mlog.info("mined conversation turns", {
    scanned: rows.length,
    created: values.length,
    ...skipped,
  });

  return { scanned: rows.length, created: values.length, skipped, candidates };
}
