import { schema } from "@arnfar/db";
import { eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { log } from "../../lib/logger.ts";
import { embedPendingForDocument } from "./embedder.ts";

const wlog = log.child("ingest-worker");

/** Ingestion job worker — the RabbitMQ replacement (CLAUDE.md decision B).
 *
 *  Claims a runnable job with FOR UPDATE SKIP LOCKED so multiple workers never grab
 *  the same row, runs it, and on failure reschedules with backoff until max_attempts.
 */

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The current tick, so shutdown can wait for an in-flight job instead of severing it. */
let inFlight: Promise<void> | null = null;

interface ClaimedJob {
  id: string;
  kind: string;
  document_id: string | null;
  attempts: number;
  max_attempts: number;
  [key: string]: unknown; // satisfies drizzle execute<T extends Record<string, unknown>>
}

async function claim(): Promise<ClaimedJob | null> {
  // Atomic claim: pick the oldest runnable job and mark it running in one statement.
  const rows = await db().execute<ClaimedJob>(sql`
    UPDATE ingest_job SET status = 'running', locked_at = now(), updated_at = now()
    WHERE id = (
      SELECT id FROM ingest_job
      WHERE status IN ('queued','running') AND run_after <= now()
      ORDER BY run_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, kind, document_id, attempts, max_attempts
  `);
  return rows[0] ?? null;
}

async function runJob(job: ClaimedJob): Promise<void> {
  if (job.kind === "embed" && job.document_id) {
    const started = performance.now();
    await embedPendingForDocument(job.document_id);
    wlog.info("job done", {
      jobId: job.id,
      kind: job.kind,
      documentId: job.document_id,
      ms: Math.round(performance.now() - started),
    });
    await db()
      .update(schema.ingestJob)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(schema.ingestJob.id, job.id));
    return;
  }
  throw new Error(`unknown job kind: ${job.kind}`);
}

async function fail(job: ClaimedJob, err: unknown): Promise<void> {
  const attempts = job.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  if (attempts >= job.max_attempts) {
    wlog.error("job failed permanently", err, {
      jobId: job.id,
      kind: job.kind,
      attempts,
      maxAttempts: job.max_attempts,
    });
    await db()
      .update(schema.ingestJob)
      .set({ status: "failed", attempts, lastError: message, updatedAt: new Date() })
      .where(eq(schema.ingestJob.id, job.id));
    return;
  }
  // Reschedule with exponential backoff.
  const backoffSec = 5 * 2 ** attempts;
  wlog.warn("job failed, retrying", {
    jobId: job.id,
    kind: job.kind,
    attempts,
    retryInSec: backoffSec,
    err: message,
  });
  await db().execute(sql`
    UPDATE ingest_job
    SET status = 'queued', attempts = ${attempts}, last_error = ${message},
        run_after = now() + ${`${backoffSec} seconds`}::interval, updated_at = now()
    WHERE id = ${job.id}
  `);
}

async function tick(): Promise<void> {
  let job = await claim();
  while (job) {
    wlog.debug("job claimed", { jobId: job.id, kind: job.kind, attempt: job.attempts + 1 });
    try {
      await runJob(job);
    } catch (err) {
      await fail(job, err);
    }
    // Stop pulling new work once shutdown has been requested — the job just finished is
    // committed, and the next one is better started by the process that will outlive it.
    job = running ? await claim() : null;
  }
}

/** Start the background worker loop. Idempotent. */
export function startWorker(intervalMs = 1500): void {
  if (running) return;
  running = true;
  wlog.info("started", { intervalMs });
  const loop = async (): Promise<void> => {
    if (!running) return;
    inFlight = tick();
    try {
      await inFlight;
    } catch (err) {
      // The next tick retries the job; what must not happen is failing silently, which
      // is how a permanently stuck queue used to look exactly like an idle one.
      wlog.error("tick failed", err);
    } finally {
      inFlight = null;
    }
    if (running) timer = setTimeout(loop, intervalMs);
  };
  void loop();
}

/**
 * Stop claiming work and wait for the job already running to finish.
 *
 * Resolves once the queue is quiet, so the caller can close the database pool without
 * cutting a transaction in half. Safe to call when the worker was never started.
 */
export async function stopWorker(): Promise<void> {
  if (!running) return;
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inFlight) {
    wlog.info("draining in-flight job");
    try {
      await inFlight;
    } catch {
      // Already logged by the loop; shutdown must not fail because a job did.
    }
  }
  wlog.info("stopped");
}
