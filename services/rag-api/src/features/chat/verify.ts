import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { newId } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";
import { judgeFaithfulness } from "../eval/judge.ts";
import { containsThai } from "../lao/lang.ts";

const vlog = log.child("chat-verify");

/**
 * Post-hoc faithfulness check on an answer that has already been delivered.
 *
 * The generator streams, the answer is stored, and until now nothing ever checked that its
 * `[n]` markers were supported by the chunks they point at. `judgeFaithfulness` has existed
 * since the eval harness was written — it simply never saw a real answer, only harness ones.
 *
 * Three things make this safe to run on every turn:
 *
 *  1. **It runs after the stream.** The reader already has the answer; a verdict that
 *     arrives a minute later costs them nothing and blocks nothing.
 *  2. **It runs cross-family.** `OLLAMA_VERIFY_MODEL` defaults to qwen3, which is not
 *     Gemma-based like the SEA-LION generator. CLAUDE.md decision 4: a generator must not
 *     judge its own output, because self-preference bias inflates the score.
 *  3. **It runs on the CPU.** 8 GB of VRAM does not hold a 9B generator and an 8B judge at
 *     once, and evicting the generator to score its own last answer would make the *next*
 *     question pay a 5–15 s model reload. `num_gpu: 0` keeps the judge off the card
 *     entirely; the twelve cores are idle while the GPU generates.
 *
 * The cost of (3) is system RAM rather than VRAM, and on a 16 GB box that is a real
 * budget: a CPU-resident qwen3:8b (6.7 GB) alongside the generator exhausted swap here and
 * the kernel OOM-killed llama-server in the middle of a user's answer. Hence a 3B judge
 * and `keep_alive: 0s` — see the sizing note on `verifyModel` in lib/env.ts. A verifier
 * that kills the generator it is checking is worse than no verifier.
 *
 * The verdict is advisory. It is written to `rag_message.meta` and shown as a badge — it
 * never rewrites the stored answer, because a judge that silently edits accounting text is
 * a worse failure mode than the one it is catching.
 */

/** Below this the answer is treated as unsupported and the reader is warned.
 *  `judgeFaithfulness` returns 1–5; 3 is "mostly supported, some drift". */
const SUPPORTED_MIN_SCORE = 4;

/** Context sent to the judge, per source. The judge reads for support, not for detail,
 *  and an 8B model on CPU gets slower with every token. */
const JUDGE_SOURCE_CHARS = 700;

export interface Verification {
  /** 1–5 from the cross-family judge. */
  score: number;
  supported: boolean;
  /** The answer stated the context did not cover the question — a correct abstention,
   *  not a failure. Tracked separately so the badge does not cry wolf over one. */
  abstained: boolean;
  /** Present when the answer carries Thai characters, which is always a defect in Lao
   *  output and is worth surfacing regardless of what the judge thought. */
  thaiContamination: boolean;
  /** Answer had no [n] marker at all — nothing to verify against. */
  uncited: boolean;
  reason: string;
  model: string;
  at: string;
}

interface StoredSourceRow {
  id?: unknown;
  content?: unknown;
  origin?: unknown;
}

/** The chunk texts the answer claimed to rest on. Web and ERP sources are included: the
 *  question is whether the ANSWER is supported by what it was shown, and it was shown
 *  those too. */
function contextsFrom(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const out: string[] = [];
  for (const s of sources) {
    if (typeof s !== "object" || s === null) continue;
    const row = s as StoredSourceRow;
    if (typeof row.content === "string" && row.content.length > 0) {
      out.push(row.content.slice(0, JUDGE_SOURCE_CHARS));
    }
  }
  return out;
}

/** The user turn this answer replied to. */
async function questionFor(
  tenant: TenantContext,
  conversationId: string,
  before: Date,
): Promise<string | null> {
  // Newest user turn strictly before the answer — the same pairing dashboard.gaps() and
  // the mining pass use. The timestamp is bound as an ISO string and cast in SQL: this
  // is a raw `sql` template, and the driver serialises bind parameters itself — handing
  // it a Date throws before the query is ever sent.
  const rows = await db().execute<{ content: string; [k: string]: unknown }>(sql`
    SELECT content FROM rag_message
    WHERE conversation_id = ${conversationId}
      AND hf_id = ${tenant.hfId} AND company_id = ${tenant.companyId}
      AND role = 'user' AND created_at < ${before.toISOString()}::timestamptz
    ORDER BY created_at DESC LIMIT 1
  `);
  return rows[0]?.content ?? null;
}

/**
 * Verify one stored assistant message and record the verdict on it.
 *
 * Returns null when the message is gone or is not an assistant turn — a conversation
 * deleted while its verification was queued is normal, not an error.
 */
export async function verifyMessage(
  tenant: TenantContext,
  messageId: string,
): Promise<Verification | null> {
  const rows = await db()
    .select({
      id: schema.ragMessage.id,
      conversationId: schema.ragMessage.conversationId,
      role: schema.ragMessage.role,
      content: schema.ragMessage.content,
      sources: schema.ragMessage.sources,
      meta: schema.ragMessage.meta,
      createdAt: schema.ragMessage.createdAt,
    })
    .from(schema.ragMessage)
    .where(
      and(
        eq(schema.ragMessage.id, messageId),
        eq(schema.ragMessage.hfId, tenant.hfId),
        eq(schema.ragMessage.companyId, tenant.companyId),
      ),
    )
    .limit(1);

  const msg = rows[0];
  if (!msg || msg.role !== "assistant") return null;

  const at = new Date().toISOString();
  const thaiContamination = containsThai(msg.content);
  const uncited = !/\[\d+\]/.test(msg.content);
  const contexts = contextsFrom(msg.sources);

  // An answer with no citation and no context never made a grounded claim to check. That
  // is usually a correct abstention ("the documents do not cover this"), so it is recorded
  // rather than scored — running an 8B judge over it would burn a minute to learn nothing.
  if (uncited && contexts.length === 0) {
    const verification: Verification = {
      score: 0,
      supported: false,
      abstained: true,
      thaiContamination,
      uncited: true,
      reason: "answer cited nothing and no context was retrieved — nothing to verify",
      model: env.verifyModel,
      at,
    };
    await store(tenant, messageId, verification);
    return verification;
  }

  const question = await questionFor(tenant, msg.conversationId, msg.createdAt);
  const judgement = await judgeFaithfulness(
    question ?? "(question unavailable)",
    msg.content,
    contexts,
    env.verifyModel,
    env.verifyOnCpu,
    env.verifyKeepAlive,
  );

  const verification: Verification = {
    score: judgement.score,
    // The judge's own boolean AND the score have to agree. `supported: true` with a score
    // of 2 is a model contradicting itself, and the badge must fail closed.
    supported: judgement.supported && judgement.score >= SUPPORTED_MIN_SCORE,
    abstained: judgement.abstained,
    thaiContamination,
    uncited,
    reason: judgement.reason,
    model: env.verifyModel,
    at,
  };

  await store(tenant, messageId, verification);
  vlog.info("verified answer", {
    messageId,
    score: verification.score,
    supported: verification.supported,
    model: verification.model,
  });
  return verification;
}

/** Merge the verdict into the message's meta, leaving everything already there intact. */
async function store(
  tenant: TenantContext,
  messageId: string,
  verification: Verification,
): Promise<void> {
  await db()
    .update(schema.ragMessage)
    .set({
      meta: sql`${schema.ragMessage.meta} || ${JSON.stringify({ verification })}::jsonb`,
    })
    .where(
      and(
        eq(schema.ragMessage.id, messageId),
        eq(schema.ragMessage.hfId, tenant.hfId),
        eq(schema.ragMessage.companyId, tenant.companyId),
      ),
    );
}

/** Read a stored verdict without running one. Returns null while it is still queued. */
export async function getVerification(
  tenant: TenantContext,
  messageId: string,
): Promise<Verification | null> {
  const rows = await db()
    .select({ meta: schema.ragMessage.meta })
    .from(schema.ragMessage)
    .where(
      and(
        eq(schema.ragMessage.id, messageId),
        eq(schema.ragMessage.hfId, tenant.hfId),
        eq(schema.ragMessage.companyId, tenant.companyId),
      ),
    )
    .limit(1);
  const meta = rows[0]?.meta as { verification?: Verification } | undefined;
  return meta?.verification ?? null;
}

/**
 * Queue a verification for an answer.
 *
 * Reuses `ingest_job` — a generic SKIP LOCKED queue in everything but its name — so no
 * broker appears (CLAUDE.md decision 1) and no second worker loop has to be written.
 */
export async function enqueueVerification(tenant: TenantContext, messageId: string): Promise<void> {
  await db().insert(schema.ingestJob).values({
    id: newId(),
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    kind: "verify",
    payload: { messageId },
    // One attempt beyond the first: a judge that failed twice is an Ollama problem, and
    // retrying it five times just occupies the queue behind real ingest work.
    maxAttempts: 2,
  });
}
