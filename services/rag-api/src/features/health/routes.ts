import { sql } from "drizzle-orm";
import { Elysia } from "elysia";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { errorMessage } from "../../lib/logger.ts";
import { SERVICE_VERSION } from "../../lib/version.ts";

/**
 * Liveness and readiness.
 *
 * These answer two different questions and must not be collapsed into one endpoint:
 *
 *   /health  — is this process up? Never touches a dependency, so a restart loop caused
 *              by a slow database is impossible. Cheap enough to poll every second.
 *   /ready   — can this process actually serve a request? Probes all four dependencies.
 *              A green /health with a red /ready is the normal state while Postgres is
 *              starting, and is exactly the distinction the old static handler erased.
 */

/** Probe outcome for one dependency. */
export interface DependencyStatus {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const PROBE_TIMEOUT_MS = 2500;

async function probe(name: string, fn: () => Promise<void>): Promise<DependencyStatus> {
  const started = performance.now();
  try {
    await fn();
    return { name, ok: true, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: errorMessage(err),
    };
  }
}

/** A HEAD/GET that fails fast rather than hanging the whole readiness check. */
async function reachable(url: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function checkDependencies(): Promise<DependencyStatus[]> {
  return Promise.all([
    probe("postgres", async () => {
      await db().execute(sql`SELECT 1`);
    }),
    probe("ollama", () => reachable(`${env.ollamaBaseUrl}/api/tags`)),
    probe("lao-nlp", () => reachable(`${env.laoNlpUrl}/health`)),
    probe("docx-extractor", () => reachable(`${env.docxExtractorUrl}/health`)),
  ]);
}

export const healthRoutes = new Elysia()
  .get("/health", () => ({
    status: "ok",
    service: "arnfar-rag-api",
    version: SERVICE_VERSION,
  }))
  .get("/ready", async ({ set }) => {
    const dependencies = await checkDependencies();
    const ok = dependencies.every((d) => d.ok);
    // 503 so a load balancer or `docker compose` healthcheck reads it without parsing.
    if (!ok) set.status = 503;
    return {
      status: ok ? "ready" : "degraded",
      service: "arnfar-rag-api",
      version: SERVICE_VERSION,
      dependencies,
    };
  });
