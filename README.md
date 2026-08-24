# Arnfar AI

**A local-first, offline-capable Lao accounting assistant — and the curated dataset behind it.**

[![CI](https://github.com/lomondev/arnfar-rag/actions/workflows/ci.yml/badge.svg)](https://github.com/lomondev/arnfar-rag/actions/workflows/ci.yml)
![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)

Every answer is grounded in a cited source document or the assistant abstains. No client
data leaves the machine — retrieval, generation, and evaluation all run locally against
Ollama.

<!-- Screenshot: run `bun run dev`, open http://localhost:3000/chat, and save a capture to
     docs/images/studio.png — then uncomment the line below.
     ![The Arnfar Studio](./docs/images/studio.png) -->

---

## What this is

Two deliverables from one pipeline. The order matters: the chat product exists to make the
dataset good, not the other way round.

| | What it is |
|---|---|
| **`arnfar-accounting-dataset`** | Versioned, licensed, immutable exports: cleaned Lao chunks, a Lao↔EN accounting glossary, cited QA pairs, SFT JSONL, and a held-out eval set. **The asset.** |
| **`arnfar-ai-chat`** | Next.js Studio + RAG API. Cited Lao accounting answers, with Promote-to-dataset and Report-wrong closing the loop back into curation. **The tool.** |

### Design constraints

These are not preferences; the product does not work without them.

- **Local-first.** No cloud LLM calls anywhere in the runtime path. Client accounting data
  never leaves the machine — that is the entire pitch.
- **Cite or abstain.** An uncited accounting claim is a liability. A QA pair cannot export
  without citations that resolve to non-rejected source chunks.
- **Lao stays Lao.** Original document text is preserved byte-for-byte. English glosses sit
  *alongside* it, never in place of it, and nothing is machine-translated. Phetsarath OT is
  self-hosted so tone-mark and vowel stacking actually compose.
- **LAK is an integer.** `BIGINT` in Postgres, `bigint` in TypeScript, plus the original
  literal string from the document. Currency never round-trips through a float.
- **Tenant isolation is enforced by the database,** not by remembering to write a `WHERE`
  clause — see [Row-level security](#row-level-security).

---

## Architecture

```
                    ┌──────────────────────────────┐
   browser ────────▶│  apps/web                    │  Next.js 15 (App Router, RSC)
                    │  host :3000                  │
                    └──────────────┬───────────────┘
                                   │  fetch / SSE
                                   ▼
                    ┌──────────────────────────────┐
                    │  services/rag-api            │  Bun + Elysia
                    │  host :7730                  │  the ONLY service with
                    └──┬────────┬────────┬─────┬───┘  inference or DB access
                       │        │        │     │
        ┌──────────────┘        │        │     └──────────────┐
        ▼                       ▼        ▼                    ▼
   Ollama :11434      lao-nlp :7731  docx-extractor    PostgreSQL 16 :5432
   host, GPU          container      :7732 container   container
   bge-m3 embeddings  LaoNLP         python-docx →     pgvector (halfvec
   SEA-LION generate  segment /      typed block       + HNSW), pg_trgm,
   qwen3 judge        normalize      stream            FTS over content_seg
```

The browser and RSC talk **only** to `rag-api`. Nothing else may reach Ollama, the sidecars,
or Postgres — that boundary is what keeps inference and data access auditable in one place.

**Retrieval** is hybrid: dense (HNSW over `content_norm` embeddings) fused with lexical
(Postgres FTS over LaoNLP-segmented `content_seg`) using Reciprocal Rank Fusion. Lao has no
inter-word spaces, so the segmented column exists purely to make the lexical index
tokenizable — the embedder always sees natural text.

---

## Requirements

| | Version | Notes |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.1 (dev on 1.3) | Runs `rag-api` and the workspace tooling |
| Docker + Compose | any recent | Postgres and the two Python sidecars |
| [Ollama](https://ollama.com) | any recent | On the **host** — it needs the GPU |
| Disk | ~20 GB free | Required models are ~12 GB; Docker images, Postgres, and dataset exports need the rest |

Python is only needed for the sidecar tooling, and `scripts/py.sh` provisions an isolated
`.venv-tools/` for it — nothing is installed into the system interpreter.

### Models

```bash
ollama pull bge-m3                                              # embeddings, 1024-dim, multilingual
ollama pull hf.co/aisingapore/Gemma-SEA-LION-v3-9B-IT-GGUF:latest   # Lao generator
ollama pull qwen3:8b                                            # cross-family judge for eval
```

Optional — only `/studio/lao-check` (Lao spelling and tone-mark correction) uses it:

```bash
ollama pull gemma-3n-laos:Q4_K_M                                # 4.2 GB, Lao-tuned Gemma 3n
```

`bge-m3` is not interchangeable. English-centric embedding models (`nomic-embed-text`,
`mxbai-embed-large`, `all-minilm`) fall back to byte-level tokenization on Lao and recall
collapses. The eval judge is deliberately a *different model family* from the generator, so
it is not grading its own work.

---

## Getting started

```bash
git clone https://github.com/lomondev/arnfar-rag.git
cd arnfar-rag
cp .env.example .env          # set POSTGRES_PASSWORD and APP_DB_PASSWORD
bun install
```

**1 — Infrastructure**

```bash
docker compose up -d          # postgres :5432, lao-nlp :7731, docx-extractor :7732
```

**2 — Database**

```bash
bun run db:migrate            # schema + row-level security policies
bun run db:app-role           # create the unprivileged role the app connects as
```

**3 — Run**

```bash
bun run dev:api               # rag-api  → http://localhost:7730
bun run dev:web               # Studio   → http://localhost:3000
```

Confirm everything is wired up:

```bash
curl -s localhost:7730/ready | jq   # probes Postgres, Ollama, and both sidecars
```

**4 — Seed data (optional)**

```bash
bun run seed                  # synthetic Lao accounting corpus for testing
```

Seed documents carry a non-authoritative `authority` on purpose. They exist to exercise the
pipeline, not to answer real questions.

### Everything in containers

```bash
docker compose --profile app up -d --build     # + rag-api and web
```

Ollama stays on the host in both modes. Inference never crosses the container boundary.

---

## Row-level security

`bun run db:app-role` is **not optional.** PostgreSQL exempts `SUPERUSER` and `BYPASSRLS`
roles from row security unconditionally — `FORCE ROW LEVEL SECURITY` only subjects the table
owner — so the tenant-isolation policies are inert while the application connects as the
cluster owner, which is what a default Compose setup gives you.

| Variable | Role |
|---|---|
| `DATABASE_URL` | The application. Points at `arnfar_app` (`NOSUPERUSER`, `NOBYPASSRLS`). |
| `ADMIN_DATABASE_URL` | Owner connection. Migrations and `db:app-role` only. |

The tenant is bound to every connection as a session GUC, and the policies compare each row
against it. Two consequences worth knowing:

- A query that forgets its tenant predicate returns the current tenant's rows, not
  everything.
- A connection with **no** tenant bound reads **zero** rows, not all of them. Starving is
  safe; over-sharing is not.

`rag-api` reports its own exposure on every boot and refuses to serve in production when its
connection can bypass RLS.

---

## Serving over a network

By default everything binds loopback and only the host machine can use it. To let colleagues
open the Studio from their own laptops or phones:

```bash
# .env
RAG_API_HOST=0.0.0.0             # accept connections from the network
CORS_ALLOW_PRIVATE_NETWORK=true  # browsers on private addresses may call the API
NEXT_PUBLIC_RAG_API_URL=         # leave EMPTY
```

Restart both services, find the host address with `hostname -I`, and everyone opens
`http://<that-address>:3000`. Nothing to rebuild, and nothing to change when DHCP moves the
address.

> **Leave `NEXT_PUBLIC_RAG_API_URL` empty.** `NEXT_PUBLIC_*` values are substituted at
> *build* time, so a literal `http://localhost:7730` in the bundle means "port 7730 on the
> machine running this browser" to every visitor — their own laptop, where nothing is
> listening. Left empty, the page derives the API address from the address it was opened on.
> Set it only for a deployment behind a fixed hostname or reverse proxy.

### ⚠ Before you turn this on

**`rag-api` has no authentication.** Anything that can reach port 7730 can read every
ledger, document, and conversation in the database. There is no login, no API key, and no
per-user scoping — the tenant is fixed by configuration.

- `CORS_ALLOW_PRIVATE_NETWORK` is a convenience for browsers, **not** a security control.
  Same-origin policy is enforced by browsers; `curl` ignores it entirely. Widening CORS lets
  the Studio work from a phone. It does not decide who can reach the data — the bind address
  does.
- Use this only on a network you trust. Do not port-forward these ports, do not put them on
  a public IP, and do not expose them through a tunnel.
- To reach it from outside the office, the honest answer is a VPN — or the authentication
  layer, which is not built yet.

`rag-api` logs a warning on every boot while bound beyond loopback, so this is hard to leave
on by accident.

---

## Configuration

Full reference in [`.env.example`](./.env.example). The ones that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Application connection (the unprivileged role) |
| `ADMIN_DATABASE_URL` | — | Owner connection, migrations only |
| `APP_DB_PASSWORD` | — | Password `db:app-role` sets on `arnfar_app` |
| `RAG_API_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` exposes to the network |
| `RAG_API_PORT` | `7730` | |
| `CORS_ORIGINS` | `http://localhost:3000` | Browser origin allowlist |
| `CORS_ALLOW_PRIVATE_NETWORK` | `false` | Also accept RFC1918 origins |
| `NEXT_PUBLIC_RAG_API_URL` | *(empty)* | Empty = derive from the page address |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_NUM_CTX` | `8192` | Set explicitly — Ollama's VRAM-based default silently drops the system prompt and citations |
| `OLLAMA_EMBED_CONCURRENCY` | `4` | Ingest must not starve chat; they share one Ollama |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / auto | `json` off a TTY |
| `OLLAMA_LAO_CORRECT_MODEL` | `gemma-3n-laos:Q4_K_M` | Only `/studio/lao-check` uses it |
| `ERP_DATABASE_URL` | *(unset)* | Unset = the bundled demo ERP schema |
| `STORAGE_FS_ROOT` | `./storage` | Original uploads, keyed by content hash |
| `DEV_HF_ID` / `DEV_COMPANY_ID` | — | Single-tenant dev seed |

---

## Development

```bash
bun run check          # everything CI runs — do this before opening a PR
bun run lint           # Biome (TS/JSON/CSS) + Ruff (Python)
bun run lint:fix
bun run typecheck      # tsc --strict × 5 packages + mypy --strict × 2 sidecars
bun run test           # bun test + pytest
```

| Command | What it does |
|---|---|
| `bun run dev` / `stop` / `status` | Whole-stack dev launcher (`scripts/dev.sh`) |
| `bun run db:generate` | Drizzle migration from the schema |
| `bun run db:migrate` | Apply migrations |
| `bun run db:app-role` | Create/refresh the unprivileged app role |
| `bun run db:index:hnsw` | Build the HNSW index **after** a bulk embed load |
| `bun run seed` | Load the synthetic test corpus |
| `bun run check:templates` | Refuse half-filled authored documents |
| `./scripts/backup.sh` | Dump + prune (nightly cron target) |

The database-backed suites — tenant isolation and the dataset export invariants — skip
themselves when no `DATABASE_URL` is set, and always run in CI. `bun run test` is green
either way; a green local run without a database has not exercised them.

The HNSW index is deliberately **not** in the Drizzle schema: bulk-inserting into a live
HNSW index is an order of magnitude slower, so it is built by a management command after
loading. Do not "fix" it back into a migration.

---

## Project layout

```
apps/web                  Next.js 15 Studio + chat        host :3000
services/rag-api          Bun + Elysia API                host :7730
services/lao-nlp          Python 3.12 · LaoNLP sidecar    container :7731
services/docx-extractor   Python 3.12 · .docx parser      container :7732
packages/db               Drizzle schema, migrations, tenant binding
packages/contracts        zod schemas shared web ↔ api
packages/ui               shared components, Phetsarath OT
datasets/                 versioned, immutable exports
storage/                  original uploads, keyed by content hash
infra/postgres            cluster init (pgvector, pg_trgm)
seed/ · templates/        synthetic corpus · authoring scaffolds
```

Both `apps/web` and `services/rag-api` are organised by feature, not by layer —
`services/rag-api/src/features/` holds `accounts`, `agent`, `chat`, `dashboard`, `erp`,
`eval`, `export`, `glossary`, `health`, `ingest`, `knowledge`, `lao`, `qa`, `review`,
`search`, `tools`, and `websearch`, each with the same `routes.ts` / `service.ts` split.

---

## Documentation

| | |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Engineering constraints and architecture decisions — read before changing anything |
| [`PROMPT.md`](./PROMPT.md) | Full build specification |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Plan of record |
| [`docs/DATA-FORMAT-STANDARD.md`](./docs/DATA-FORMAT-STANDARD.md) | Canonical dataset formats |
| [`docs/ARCHITECTURE-PHASE1.md`](./docs/ARCHITECTURE-PHASE1.md) | Ingestion pipeline detail |
| [`docs/ERP-INTEGRATION.md`](./docs/ERP-INTEGRATION.md) | Connecting a live ERP database read-only |

---

## Status

Development proceeds through approval-gated phases (`PROMPT.md` §6).

**Gates 0–5 are passed.** Ingestion, human review, QA and glossary curation, hybrid
retrieval, chat with citations, versioned export, the eval harness, and read-only live-ERP
tools are all shipped.

**Gate 6 — retrieval quality — is open:** recall@5 ≥ 0.9 and faithfulness ≥ 0.8 measured on
real data, judged cross-family, never tuned on the held-out test split. The blocker is
dataset volume rather than platform capability: the platform is ahead of the data, so the
work is filling the factory rather than extending it. [`docs/ROADMAP.md`](./docs/ROADMAP.md)
is the plan.

Known gaps, stated rather than buried: **there is no authentication layer**, and
schema-validated request bodies cover 48 of 75 API routes.
