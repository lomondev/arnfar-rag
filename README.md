# Arnfar AI — Lao Accounting RAG + Dataset Platform

Local-first, offline-capable Lao accounting AI assistant. The **primary deliverable is a
curated, exportable Lao accounting dataset**; the chat product is the curation surface that
makes the dataset good.

- **Source of truth for the build:** [`PROMPT.md`](./PROMPT.md)
- **Rules enforced on every session:** [`CLAUDE.md`](./CLAUDE.md)

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
datasets/             exported dataset artifacts (git-lfs)
infra/postgres        Postgres init (pgvector, pg_trgm)
storage/              object-storage volume (originals) — fs driver
```

Ollama runs on the **host** (`:11434`). Postgres + the two Python sidecars run in Docker.
`rag-api` and `web` run on the host via Bun/Next.

## Quick start

```bash
cp .env.example .env          # then edit secrets
docker compose up -d          # postgres + lao-nlp + docx-extractor
bun install
bun run typecheck
bun run db:migrate            # once the schema phase lands
bun run dev:api               # :7730
bun run dev:web               # :3000
```

## Build status

Approval-gated phases (see `PROMPT.md` §6). Current: **Phase 0 — scaffold** complete at GATE 0.
