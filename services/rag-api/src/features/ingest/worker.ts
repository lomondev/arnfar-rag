import { schema } from "@arnfar/db";
import { eq, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { embedPendingForDocument } from "./embedder.ts";

/** Ingestion job worker — the RabbitMQ replacement (CLAUDE.md decision B).
 *
 *  Claims a runnable job with FOR UPDATE SKIP LOCKED so multiple workers never grab
 *  the same row, runs it, and on failure reschedules with backoff until max_attempts.
 */

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

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
    await embedPendingForDocument(job.document_id);
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
    await db()
      .update(schema.ingestJob)
      .set({ status: "failed", attempts, lastError: message, updatedAt: new Date() })
      .where(eq(schema.ingestJob.id, job.id));
    return;
  }
  // Reschedule with exponential backoff.
  const backoffSec = 5 * 2 ** attempts;
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
    try {
      await runJob(job);
    } catch (err) {
      await fail(job, err);
    }
    job = await claim();
  }
}

/** Start the background worker loop. Idempotent. */
export function startWorker(intervalMs = 1500): void {
  if (running) return;
  running = true;
  const loop = async (): Promise<void> => {
    if (!running) return;
    try {
      await tick();
    } catch {
      // swallow — next tick retries
    }
    timer = setTimeout(loop, intervalMs);
  };
  void loop();
}

export function stopWorker(): void {
  running = false;
  if (timer) clearTimeout(timer);
}
