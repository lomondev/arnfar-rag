import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { accountsRoutes } from "./features/accounts/routes.ts";
import { agentRoutes } from "./features/agent/routes.ts";
import { chatRoutes } from "./features/chat/routes.ts";
import { dashboardRoutes } from "./features/dashboard/routes.ts";
import { erpRoutes } from "./features/erp/routes.ts";
import { evalRoutes } from "./features/eval/routes.ts";
import { exportRoutes } from "./features/export/routes.ts";
import { glossaryRoutes } from "./features/glossary/routes.ts";
import { healthRoutes } from "./features/health/routes.ts";
import { ingestRoutes } from "./features/ingest/routes.ts";
import { startWorker, stopWorker } from "./features/ingest/worker.ts";
import { knowledgeRoutes } from "./features/knowledge/routes.ts";
import { laoRoutes } from "./features/lao/routes.ts";
import { qaRoutes } from "./features/qa/routes.ts";
import { reviewRoutes } from "./features/review/routes.ts";
import { searchRoutes } from "./features/search/routes.ts";
import { toolsRoutes } from "./features/tools/routes.ts";
import { websearchRoutes } from "./features/websearch/routes.ts";
import { corsOrigin } from "./lib/cors.ts";
import { closeDb } from "./lib/db.ts";
import { assertEmbeddingProvenance } from "./lib/embedding-guard.ts";
import { env } from "./lib/env.ts";
import { newId } from "./lib/ids.ts";
import { log } from "./lib/logger.ts";
import { assertTenantIsolation } from "./lib/tenant-guard.ts";
import { SERVICE_VERSION } from "./lib/version.ts";

/**
 * arnfar-rag-api — the only service that touches Ollama, the Python sidecars, and
 * Postgres. Next.js talks ONLY to this (CLAUDE.md boundary rule).
 */
export const app = new Elysia()
  .use(
    cors({
      // An allowlist, not `*`. rag-api holds client accounting data and answers with no
      // credentials of its own, so any origin that can reach it can read that data.
      // See lib/cors.ts — the predicate also accepts private-network origins when
      // CORS_ALLOW_PRIVATE_NETWORK is on, which is what makes the Studio usable from a
      // phone without pinning a DHCP address in the allowlist.
      origin: corsOrigin,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  )
  .onError(({ error, code, set, path, request }) => {
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "not found" };
    }
    if (code === "VALIDATION") {
      // Validation messages describe the request the caller sent, so echoing them back
      // helps rather than leaks.
      set.status = 422;
      return { error: "validation", message: error.message };
    }
    // Everything else: the detail goes to the log, the caller gets a correlation id.
    // The previous handler returned error.message verbatim, which handed Postgres and
    // Ollama internals — table names, connection strings, prompts — to the browser.
    const errorId = newId();
    log.error("unhandled request error", error, { errorId, path, method: request.method });
    set.status = 500;
    return { error: "internal error", errorId };
  })
  .use(healthRoutes)
  .use(ingestRoutes)
  .use(reviewRoutes)
  .use(searchRoutes)
  .use(qaRoutes)
  .use(glossaryRoutes)
  .use(accountsRoutes)
  .use(toolsRoutes)
  .use(agentRoutes)
  .use(exportRoutes)
  .use(evalRoutes)
  .use(chatRoutes)
  .use(dashboardRoutes)
  .use(knowledgeRoutes)
  .use(websearchRoutes)
  .use(erpRoutes)
  .use(laoRoutes)
  // idleTimeout 255s (Bun max): SSE chat streams idle between the citations frame and
  // the LLM's first token (prompt eval) — the 10s default would kill the stream.
  .listen({ hostname: env.host, port: env.port, idleTimeout: 255 });

// Start the background ingestion worker (SKIP LOCKED job queue — decision B).
startWorker();

// Report — loudly — if this process is connected in a way that defeats the tenant
// policies. Deliberately not awaited before listen(): a database that is still starting
// should delay readiness, not refuse to boot. /ready covers that case.
void assertTenantIsolation();

// Same treatment for the other silent-corruption risk: vectors produced by a model other
// than the one this process embeds queries with. Postgres has no error for that.
void assertEmbeddingProvenance();

log.info("listening", {
  url: `http://${env.host}:${app.server?.port ?? env.port}`,
  version: SERVICE_VERSION,
  corsOrigins: env.corsOrigins.join(","),
  corsAllowPrivateNetwork: env.corsAllowPrivateNetwork,
});

// Bound to something other than loopback means every machine that can route to this port
// can read every ledger this service serves — there is no authentication layer yet. That
// is a legitimate choice on a trusted office network and a serious one anywhere else, so
// it is stated on every boot rather than left to be discovered.
if (env.host !== "127.0.0.1" && env.host !== "localhost" && env.host !== "::1") {
  log.warn("reachable beyond this machine and the API has NO authentication", {
    host: env.host,
    port: env.port,
    advice: "trusted networks only — do not port-forward or expose to the internet",
  });
}

/**
 * Graceful shutdown.
 *
 * Without this, a restart kills the worker mid-job and drops the connection pool without
 * draining: the SKIP LOCKED queue recovers the row on the next boot, but the embedding
 * batch already paid for is thrown away, and any in-flight SSE stream dies unflushed.
 *
 * Order matters — stop accepting work, let the current job finish, then close the pool.
 * A second signal skips the wait, because a shutdown you cannot interrupt is its own bug.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn("second signal — exiting immediately", { signal });
    process.exit(1);
  }
  shuttingDown = true;
  log.info("shutting down", { signal });

  try {
    await app.stop();
    await stopWorker();
    await closeDb();
    log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    log.error("shutdown failed", err);
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on("unhandledRejection", (reason) => {
  // Never silently swallow: an unhandled rejection here is a bug with no other symptom.
  log.error("unhandled rejection", reason, { fatal: false });
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception — shutting down", err, { fatal: true });
  void shutdown("uncaughtException");
});
