# apps/web — Next.js 15. Built from the REPOSITORY ROOT:
#   docker build -f apps/web/Dockerfile .
# It consumes @arnfar/ui and @arnfar/contracts as workspace source (transpilePackages),
# so the build context has to include them.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY services/rag-api/package.json services/rag-api/
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-slim AS build
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/ui ./packages/ui
COPY packages/contracts ./packages/contracts

# Bun keeps workspace dependencies per package rather than hoisting them; copied after
# the source so the source COPY cannot shadow them.
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules

# Baked into the client bundle at build time, so it cannot be changed by the runtime
# environment. Empty by default on purpose: the page then resolves the API from the address
# it was loaded over (src/lib/api.ts), so one image works on localhost, on a LAN IP, and
# behind a hostname. Set it only when the API lives somewhere the page cannot infer.
ARG NEXT_PUBLIC_RAG_API_URL=
ARG RAG_API_PORT=7730
ENV RAG_API_PORT=$RAG_API_PORT
ENV NEXT_PUBLIC_RAG_API_URL=$NEXT_PUBLIC_RAG_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/web ./apps/web
COPY --from=build /repo/packages/ui ./packages/ui
COPY --from=build /repo/packages/contracts ./packages/contracts
COPY --from=build /repo/node_modules ./node_modules

USER bun
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD bun --eval "const r = await fetch('http://localhost:3000/'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "--cwd", "apps/web", "start"]
