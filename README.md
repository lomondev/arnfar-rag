# Arnfar AI — Lao Accounting RAG + Dataset Platform

Local-first, offline-capable Lao accounting AI assistant. The **primary deliverable is a
curated, exportable Lao accounting dataset**; the chat product is the curation surface that
makes the dataset good.

- **Source of truth for the build:** [`PROMPT.md`](./PROMPT.md)
- **Rules enforced on every session:** [`CLAUDE.md`](./CLAUDE.md)
- **Plan of record:** [`docs/ROADMAP.md`](./docs/ROADMAP.md)

## Two products, one pipeline

| Product | What it is |
|---|---|
| `arnfar-accounting-dataset` | Versioned, licensed, exportable dataset: cleaned chunks, Lao↔EN glossary, QA pairs, SFT JSONL, eval set. **The asset.** |
| `arnfar-ai-chat` | Next.js chat UI + RAG API. Cited Lao accounting answers. **The tool.** |

## Layout

```
apps/web              Next.js 15 (App Router, RSC)         host, :3000
services/rag-api      Bun + Elysia RAG API                 host, :7730
services/lao-nlp      Python 3.12 FastAPI — LaoNLP sidecar container, :7731
services/docx-extractor Python 3.12 FastAPI — .docx parser container, :7732
packages/db           Drizzle schema + migrations (single source of truth)
packages/contracts    zod schemas shared web ↔ api
packages/ui           shared components, Phetsarath OT
datasets/             exported dataset artifacts
infra/postgres        Postgres init (pgvector, pg_trgm)
storage/              object-storage volume (originals) — fs driver
```

Ollama runs on the **host** (`:11434`). Postgres + the two Python sidecars run in Docker.
`rag-api` and `web` run on the host via Bun/Next for development, and have their own
images for a containerised install (`--profile app`, below).

## Quick start

```bash
cp .env.example .env          # then edit secrets
docker compose up -d          # postgres + lao-nlp + docx-extractor
bun install

bun run db:migrate            # schema + row-level security policies
bun run db:app-role           # create the unprivileged role the app connects as
                              # (needs APP_DB_PASSWORD in .env — see below)

bun run dev:api               # :7730
bun run dev:web               # :3000
```

**`db:app-role` is not optional.** PostgreSQL exempts `SUPERUSER` and `BYPASSRLS` roles
from row security, so the tenant-isolation policies do nothing while the app connects as
the cluster owner. `DATABASE_URL` should point at `arnfar_app`; `ADMIN_DATABASE_URL` keeps
the owner connection for migrations. rag-api logs a warning at startup if its connection
can bypass RLS, and refuses to start in production.

### Everything in containers

```bash
docker compose --profile app up -d --build   # + rag-api and web
```

Ollama stays on the host in both modes — it needs the GPU, and inference never crosses the
container boundary.

## Checks

```bash
bun run check          # exactly what CI runs
bun run lint           # biome (TS/JSON/CSS) + ruff (Python)
bun run lint:fix
bun run typecheck      # tsc --strict across 5 packages + mypy --strict on both sidecars
bun run test           # bun test + pytest
```

The database-backed suites — tenant isolation and the dataset export invariants — skip
themselves when no `DATABASE_URL` is configured, and always run in CI.

Python tooling installs into a local `.venv-tools/` via `scripts/py.sh`; nothing is
installed into the system interpreter.

## Build status

Phases are approval-gated (`PROMPT.md` §6). Phases 0–5 are complete: ingest, review,
QA/glossary curation, hybrid retrieval, chat with citations, versioned export, eval
harness, and the live-ERP read-only tools. **GATE 6 — the retrieval quality bar
(recall@5 ≥ 0.9, faithfulness ≥ 0.8 on real data) — is the open gate**, and
[`docs/ROADMAP.md`](./docs/ROADMAP.md) is the plan for reaching it: the platform is ahead
of the data, so the work is filling the dataset factory rather than adding to it.
