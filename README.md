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

## Serving the site over your network

By default everything binds loopback and only this machine can use it. To let colleagues on
the same network open the Studio from their own laptops or phones:

```bash
# .env
RAG_API_HOST=0.0.0.0             # rag-api accepts connections from the network
CORS_ALLOW_PRIVATE_NETWORK=true  # browsers on private addresses may call it
NEXT_PUBLIC_RAG_API_URL=         # leave EMPTY — see below
```

Restart both services and find this machine's address with `hostname -I`. Everyone else
opens `http://<that-address>:3000`. Nothing else to configure, and nothing to rebuild when
the address changes.

**Leave `NEXT_PUBLIC_RAG_API_URL` empty.** `NEXT_PUBLIC_*` values are substituted at build
time, so a literal `http://localhost:7730` compiled into the bundle means "port 7730 on the
machine running the browser" to every visitor — their own laptop, where nothing is
listening. Left empty, the page derives the API address from the address it was opened on.
Set it only for a deployment behind a fixed hostname or a reverse proxy, where there is
nothing to derive.

### Read this before you turn it on

**rag-api has no authentication.** Anything that can reach port 7730 can read every ledger,
document, and conversation in the database. There is no login, no API key, and no
per-user scoping — the tenant is fixed by configuration.

- `CORS_ALLOW_PRIVATE_NETWORK` is a convenience for browsers, **not** a security control.
  Same-origin policy is enforced by the browser; `curl` ignores it completely. Widening
  CORS lets the Studio work from a phone. It does not decide who can reach the data — the
  bind address does.
- Use this on a network you trust. Do not port-forward these ports, do not put them on a
  public IP, and do not expose them through a tunnel. Everything in this database is
  client accounting data, and local-first is the product's whole pitch.
- If you need it reachable from outside the office, the honest answer is a VPN — or the
  authentication layer, which is still unbuilt.

`bun run dev:api` prints a warning on every boot while it is bound beyond loopback, so this
is hard to leave on by accident.

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
