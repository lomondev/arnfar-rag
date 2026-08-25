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

### The pipeline, end to end

The dataset is not a by-product of the chat app; it is the point. Every stage below exists
to move a document from "somebody's `.docx`" to "a cited row a person approved".

```
.docx / .md
    │  docx-extractor → typed block stream (headings, tables, lists preserved)
    ▼
chunker              heading-aware · tables kept atomic · Lao sentences never split
    │
    ▼  lao-nlp /segment + /normalize
rag_chunk            content (pristine) · content_norm (embed) · content_seg (lexical)
    │  review = 'pending', embedding = NULL
    ▼  Ollama bge-m3 — idempotent, resumable, concurrency-capped
embedded chunks      + embed_model provenance, checked at every boot
    │
    ▼  /studio/review — a person accepts, edits, or rejects
accepted chunks      rejected chunks never retrieve and never export
    │
    ├──▶ /studio/teach · /studio/qa      → cited QA pairs
    ├──▶ /studio/glossary                → Lao↔EN terms, variants, forbidden forms
    ▼
/studio/export       versioned, immutable, sha256 manifest + data card
    │
    ▼
/studio/eval         recall@k · MRR · faithfulness, judged cross-family
```

`/chat` sits on top of the same corpus and closes the loop: **Promote-to-dataset** turns a
good answer into a QA pair, **Report-wrong** flags the chunks behind a bad one.

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

**Retrieval** is hybrid by design: dense (HNSW over `content_norm` embeddings) fused with
lexical (Postgres FTS over LaoNLP-segmented `content_seg`) using Reciprocal Rank Fusion at
k=60. Lao has no inter-word spaces, so the segmented column exists purely to make the lexical
index tokenizable — the embedder always sees natural text. The three text columns on
`rag_chunk` are not interchangeable and getting them wrong collapses recall silently:

| Column | Contents | Feeds |
|---|---|---|
| `content` | original Lao, byte-for-byte | display, LLM prompt context |
| `content_norm` | NFC, zero-width stripped, whitespace collapsed | **dense embedding** |
| `content_seg` | LaoNLP tokens joined by spaces | **`tsvector` / lexical only** |

> ⚠ The lexical arm is currently returning no rows — see
> [Known gaps](#known-gaps-stated-rather-than-buried). Retrieval is dense-only in practice.

---

## What you can actually do with it

**`/chat`** — ask an accounting question in Lao and get a cited answer, or an abstention.

- Streaming answers with a live retrieve → read → write progress indicator
- **Citations you can open** — inline `[n]` chips and a per-answer reference list; clicking
  either opens the source panel with the pristine chunk text, authority, and effective date
- Table sources render as tables, in the answer and in the source panel
- **Edit any question and resend** — later turns are dropped so the thread stays coherent
- **Values in the question** get computed, not guessed: *"ຄິດໄລ່ອາກອນ 5,000,000 ກີບ 10%"*
  runs an integer-only calculator server-side and cites the result
- Knowledge-scope and model pickers, opt-in internet augmentation (off by default),
  per-answer LaoNLP spell/terminology check
- **Promote-to-dataset** and **Report-wrong** feed curation

**`/studio/*`** — the dataset factory.

| Page | Purpose |
|---|---|
| `/studio` | Overview dashboard and the gaps queue — questions the corpus answered badly |
| `/studio/ingest` | Upload `.docx` / `.md`, watch extraction → chunking → embedding |
| `/studio/review` | Accept, edit, or reject chunks; rejected never retrieves or exports |
| `/studio/teach` | Claude-style curation chat — answer, correct, approve in one pass |
| `/studio/qa` · `/studio/glossary` · `/studio/knowledge` | CRUD for QA pairs, Lao↔EN terms, and knowledge entries |
| `/studio/lao-check` | LaoNLP spelling + glossary terminology, with a minimal-edit suggestion |
| `/studio/export` | Versioned immutable export with a sha256 manifest and data card |
| `/studio/eval` | Retriever matrix, recall/MRR/faithfulness, gate thresholds |

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
bun run test           # bun test + pytest — 188 TS + 33 Python at time of writing
```

| Command | What it does |
|---|---|
| `bun run dev` / `stop` / `status` | Whole-stack dev launcher (`scripts/dev.sh`) |
| `bun run db:generate` | Drizzle migration from the schema |
| `bun run db:migrate` | Apply migrations |
| `bun run db:app-role` | Create/refresh the unprivileged app role |
| `bun run db:index:hnsw` | Build the HNSW index **after** a bulk embed load |
| `bun run db:reembed --dry-run` | Which embedding model produced which vectors |
| `bun run db:reembed` | Re-embed vectors that are not from the configured model |
| `bun run seed` | Load the synthetic test corpus |
| `bun run check:templates` | Refuse half-filled authored documents |
| `./scripts/backup.sh` | Dump + prune (nightly cron target) |

The database-backed suites — tenant isolation, the `embed_model` invariant, and the dataset
export rules — skip themselves when no `DATABASE_URL` is set, and always run in CI. `bun run test` is green
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

## How it got here

Development runs through approval-gated phases (`PROMPT.md` §6); nothing advances without
the previous gate's checklist passing. Roughly 67 commits, in this order:

| Phase | What landed |
|---|---|
| **0–4** | Monorepo scaffold, Drizzle schema, the two Python sidecars, the ingestion pipeline, and hybrid retrieval |
| **5** | Dataset tooling — QA curator, glossary builder, versioned immutable export |
| **6** | Eval harness — retriever matrix, faithfulness and abstention judging |
| **7–8** | Cited streaming chat, Lao check, SEA-LION as the default generator |

After the initial phases the work turned to hardening and to the Studio as a real curation
surface:

- **Server-persisted conversations** (`rag_conversation` / `rag_message`) replacing localStorage
- **Studio build-out** — overview dashboard and gaps queue, teach mode, ingest workbench,
  user-defined knowledge kinds, entry search, full CRUD for QA / glossary / chart of accounts
- **Live-ERP read-only tools** cited in chat, behind `features/agent` + `features/tools`
- **Retrieval correctness** — follow-up condensing, an RRF candidate floor so top-1 is stable
  across `k`, provenance carried through citations
- **Row-level security** — tenant isolation moved out of convention and into Postgres policies,
  with `FORCE ROW LEVEL SECURITY` and a two-tenant regression test
- **Load-bearing contracts** — the web parses API responses with the shared zod schemas
  instead of casting, so drift is a named error at the fetch boundary
- **Operational baseline** — Biome + Ruff across the whole repo, structured logging, graceful
  shutdown, a real readiness probe, container images, CI, nightly backups
- **Recent** — embedding-model provenance with a boot-time guard; an eval harness that refuses
  to record a metric it did not measure; Lao answer repair (word-space joining, typography);
  clickable citations and rendered tables in chat; edit-and-resend; a deterministic integer
  VAT calculator driven by values written in the question

---

## Where it stands

Measured against the live development database, not asserted:

| | Now | Phase-2 target |
|---|---|---|
| Documents ingested | 12 | all core MoF / company documents |
| Chunks (all embedded) | 100 | — |
| Chunks human-accepted | 34 | — |
| Verified QA pairs | 41 | 300–500 |
| Verified glossary terms | 1 of 46 | ~150 |
| Verified account rows | 0 of 96 | — |
| Knowledge kinds defined | 0 | ~10 |

**Latest eval** — hybrid RRF over 41 verified QA pairs:

| Metric | Result | Gate 6 bar |
|---|---|---|
| recall@5 | **0.927** | ≥ 0.9 ✅ |
| recall@10 | 0.927 | — |
| MRR | 0.770 | — |
| p95 retrieval | 8 ms | < 150 ms ✅ |
| faithfulness | **not yet measured** | ≥ 0.8 |

Read those two ticks narrowly. The corpus is 100 chunks, so 8 ms says nothing about the
budget's real target of 200k chunks, and 41 queries is just past the 30-query threshold below
which a recall figure cannot separate 0.9 from 0.7. Faithfulness needs the generation arm,
which has not been run.

**Gate 6 is therefore still open**, and the blocker remains dataset volume rather than
platform capability — [`docs/ROADMAP.md`](./docs/ROADMAP.md) is the plan for closing it.

### Known gaps, stated rather than buried

- **There is no authentication layer.** The bind address is the only thing between the
  ledgers and the network. See [Serving over a network](#serving-over-a-network).
- **The lexical half of hybrid retrieval currently returns nothing.** The FTS index is
  healthy, but the query is built with `plainto_tsquery`, which ANDs every term — a
  14-token segmented Lao question demands all 14 tokens in one chunk and matches zero rows.
  The eval matrix shows it plainly: `dense 0.927` / `lexical 0.000` / `hybrid 0.927`.
  Retrieval is dense-only in practice until the query becomes disjunctive.
- **The corpus is authored space-segmented.** Lao is written without inter-word spaces, but
  `seed/` and `templates/` put a space between every word, so answers inherit the defect.
  It is repaired at generation time; the durable fix is re-authoring the source.
- Schema-validated request bodies cover 48 of 75 API routes.
- 100 chunks carry no embedding provenance (they predate the `embed_model` column);
  `bun run db:reembed --dry-run` reports them.
