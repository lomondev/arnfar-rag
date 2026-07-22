import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

import { accountsRoutes } from "./features/accounts/routes.ts";
import { agentRoutes } from "./features/agent/routes.ts";
import { chatRoutes } from "./features/chat/routes.ts";
import { dashboardRoutes } from "./features/dashboard/routes.ts";
import { knowledgeRoutes } from "./features/knowledge/routes.ts";
import { evalRoutes } from "./features/eval/routes.ts";
import { exportRoutes } from "./features/export/routes.ts";
import { glossaryRoutes } from "./features/glossary/routes.ts";
import { ingestRoutes } from "./features/ingest/routes.ts";
import { laoRoutes } from "./features/lao/routes.ts";
import { startWorker } from "./features/ingest/worker.ts";
import { qaRoutes } from "./features/qa/routes.ts";
import { reviewRoutes } from "./features/review/routes.ts";
import { searchRoutes } from "./features/search/routes.ts";
import { toolsRoutes } from "./features/tools/routes.ts";
import { env } from "./lib/env.ts";

/**
 * arnfar-rag-api — the only service that touches Ollama, the Python sidecars, and
 * Postgres. Next.js talks ONLY to this (CLAUDE.md boundary rule).
 */
export const app = new Elysia()
  .use(cors()) // browser (web:3000) → rag-api (7730); Next never calls sidecars/Ollama
  .onError(({ error, code, set }) => {
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "not found" };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: "validation", message: error.message };
    }
    console.error("[rag-api]", error);
    set.status = 500;
    return { error: error instanceof Error ? error.message : "internal error" };
  })
  .get("/health", () => ({ status: "ok", service: "arnfar-rag-api", version: "0.3.0" }))
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
  .use(laoRoutes)
  // idleTimeout 255s (Bun max): SSE chat streams idle between the citations frame and
  // the LLM's first token (prompt eval) — the 10s default would kill the stream.
  .listen({ port: env.port, idleTimeout: 255 });

// Start the background ingestion worker (SKIP LOCKED job queue — decision B).
startWorker();

console.log(`arnfar-rag-api listening on http://localhost:${app.server?.port ?? env.port}`);
