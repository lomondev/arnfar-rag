# rag-api — Bun + Elysia. The only service that touches Ollama, the Python sidecars,
# and Postgres (CLAUDE.md boundary rule).
#
# Built from the REPOSITORY ROOT, not from this directory:
#   docker build -f services/rag-api/Dockerfile .
# The service imports @arnfar/db and @arnfar/contracts as workspace source, and Bun
# resolves workspaces through the root bun.lock — a context rooted here could not see
# either.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /repo

# Manifests first, so a dependency layer is only rebuilt when a manifest changes.
COPY package.json bun.lock ./
COPY services/rag-api/package.json services/rag-api/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json bun.lock tsconfig.base.json ./
COPY services/rag-api ./services/rag-api
COPY packages/db ./packages/db
COPY packages/contracts ./packages/contracts

# Bun does NOT hoist workspace dependencies to the root — each workspace keeps its own
# node_modules, and the root tree alone resolves nothing. Copied after the source so the
# source COPY cannot shadow them.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/services/rag-api/node_modules ./services/rag-api/node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules

# Dataset exports and uploaded originals are written at runtime and must outlive the
# container — mount volumes over both.
RUN mkdir -p /repo/storage/originals /repo/datasets && chown -R bun:bun /repo/storage /repo/datasets
VOLUME ["/repo/storage", "/repo/datasets"]

USER bun
EXPOSE 7730

# /health is liveness only. Readiness (/ready) probes Postgres, Ollama, and both
# sidecars — deliberately not used here, or a slow database would restart-loop the API.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD bun --eval "const r = await fetch('http://localhost:7730/health'); process.exit(r.ok ? 0 : 1)"

# Bun runs TypeScript directly; there is no build step to skip. Signals reach PID 1, which
# is what makes the graceful shutdown in src/index.ts actually fire on `docker stop`.
CMD ["bun", "run", "services/rag-api/src/index.ts"]
