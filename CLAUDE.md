# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Arnfar AI is a **local-first, offline-capable Lao accounting RAG + dataset platform**. The
**primary deliverable is a curated, exportable Lao accounting dataset**; the chat product is the
curation surface that makes the dataset good. Build order reflects this — the dataset factory
(ingest → review → QA/glossary → export → eval) comes before the chat UI.

Full spec: [`PROMPT.md`](./PROMPT.md). Build proceeds in **approval-gated phases** (see below).

---

## Hard constraints — never violate these

**Stack**
- **TypeScript strict everywhere.** No implicit `any`, no `as any`. `tsconfig.base.json` is the
  root; every package extends it.
- **Drizzle ORM only. Never Prisma.**
- **PostgreSQL 16 + pgvector ≥ 0.8** (needs `halfvec` and HNSW iterative scan) + `pg_trgm`.
- **Bun + Elysia** for `services/rag-api`. **Next.js 15 App Router (RSC default)** for `apps/web`.
- **Python 3.12 + FastAPI ONLY** for `services/lao-nlp` and `services/docx-extractor`. Nowhere else.
- **Ollama for all inference. No cloud LLM calls anywhere in the runtime path.** Ever.
- **Feature-based folders**: `src/features/{name}/` in both web and rag-api.

**Money & numbers**
- **LAK is ALWAYS an integer.** `BIGINT` in Postgres, `bigint` in TypeScript. **Never**
  `float` / `number` / `numeric` for currency.
- A monetary amount extracted from a document is stored as `BIGINT` LAK **plus the original
  literal string**. Never round. The extractor does not parse amounts to numbers — it captures
  the literal.

**Multi-tenancy**
- Hierarchy `hf_id → company_id → branch_id`, enforced **at the query level on every table**.
- Every RAG table carries `hf_id` and `company_id` **denormalized** (tenant filter with no join).
- No query touches a tenant-scoped table without `hf_id = $x AND company_id = $y` in its `WHERE`.
  No exceptions, no "add it later".

**Lao language**
- **Phetsarath OT** for all Lao rendering — UI and exports. Self-hosted, subset, `font-display: swap`.
  Verify tone-mark / vowel stacking renders (most fallback fonts break Lao composition).
- **Never machine-translate Lao text.** Lao stays Lao. English glosses are added *alongside*,
  never *instead of*. The UI language toggle switches chrome only — never content.
- **Original document text is preserved byte-for-byte in `content`.** Normalization output lives
  in separate columns (`content_norm`, `content_seg`). `content` is never mutated except by an
  explicit human Edit in the review UI.

**The three text columns on `rag_chunk` (get this right or recall silently collapses):**
| Column | Contents | Used for |
|---|---|---|
| `content` | original, pristine Lao — byte-for-byte | display, LLM prompt context |
| `content_norm` | NFC, ZWSP-stripped (`U+200B`/`U+FEFF`), whitespace-collapsed | **dense embedding input** |
| `content_seg` | LaoNLP tokens joined by spaces | **`tsvector` / lexical (BM25) input only** |
- **Embed `content_norm`. NEVER embed `content_seg`.** Injecting word-boundary spaces corrupts
  bge-m3's own tokenization and quietly degrades dense recall. `content_seg` exists solely so
  `to_tsvector('simple', content_seg)` can tokenize spaceless Lao. Queries are segmented the same
  way before hitting `fts`, and embedded from their natural form for the dense side.

**Integrity**
- **UUIDv7** for all cross-service identifiers, generated **application-side** (Postgres 16 has no
  native `uuidv7()` — that's PG18). TS uses the `uuidv7` package; Python sidecars that mint ids
  use `uuid6`. Keep them consistent.
- `outbox_event` inserts happen **in the same DB transaction** as the state change they describe.
  **Never publish/emit to an external system inside a DB transaction.**

**Boundaries**
- **Next.js never calls Ollama or the Python sidecars directly.** The browser and RSC talk ONLY
  to `rag-api` (`NEXT_PUBLIC_RAG_API_URL`). `rag-api` is the only thing that touches Ollama,
  lao-nlp, docx-extractor, and Postgres.

---

## Phase-0 architecture decisions (rationale — do not silently revert)

These were decided against the original spec after review. If you think one should change, raise
it — do not just undo it.

1. **RabbitMQ + transactional-outbox-over-a-broker was dropped.** For a local-first single-node
   deployment there is no second out-of-process consumer, so a broker is unjustified complexity.
   The ingestion pipeline is an in-process job driven by a **Postgres job table with
   `SELECT ... FOR UPDATE SKIP LOCKED`**. Resumability (the real requirement) comes from
   `WHERE embedding IS NULL`. `outbox_event` is **kept as an append-only audit/event log** so the
   pattern is there if a real consumer ever appears. If you add a broker, justify the consumer first.
2. **Object storage = local filesystem volume** (`storage/`, `STORAGE_DRIVER=fs`) behind a thin
   storage interface. Swap to S3/MinIO later without touching callers. Originals of every `.docx`
   live under `storage/originals/`, keyed by `content_sha256`.
3. **HNSW index is NOT in the declarative Drizzle schema.** It is created by a management command
   (`bun run db:index:hnsw`) **after the first bulk embed load** — bulk-inserting into a live HNSW
   index is an order of magnitude slower. This is a deliberate exception to "Drizzle is the single
   source of truth"; a future session must not "fix" the HNSW index back into a migration.
4. **Cross-encoder reranking (`bge-reranker-v2-m3` in the lao-nlp sidecar) and cross-model
   LLM-judging** (gemma3 judges qwen3 and vice versa, calibrated against ~20 human labels) are the
   plan for Phase 6/7 — the generator must not judge or rerank its own output with the same model.
5. **Multi-tenant columns and query filters exist everywhere from day one**, but the dev
   environment seeds a **single tenant** (`DEV_HF_ID` / `DEV_COMPANY_ID` in `.env`).

---

## Commands

Bun runs on the host. Postgres + the two Python sidecars run in Docker. Ollama runs on the host.

```bash
# infra
docker compose up -d               # postgres (:5432) + lao-nlp (:7731) + docx-extractor (:7732)
docker compose down
docker compose logs -f lao-nlp

# workspace
bun install
bun run typecheck                  # bun run --filter '*' typecheck  (strict tsc across all packages)
bun run --filter '@arnfar/db' typecheck   # single package

# database (packages/db — Drizzle)
bun run db:generate                # drizzle-kit generate (SQL migration from schema)
bun run db:migrate                 # apply migrations
bun run db:index:hnsw              # build the HNSW index AFTER a bulk embed load (see decision 3)

# run services on the host
bun run dev:api                    # rag-api  :7730
bun run dev:web                    # web      :3000

# ollama models (host) — verify before trusting
ollama pull bge-m3                 # embeddings, 1024-dim, multilingual. Required for Lao.
ollama pull qwen3:8b               # generator
ollama pull gemma3:12b             # generator alternative (benched in Phase 6)
```

**Forbidden embedding models:** `nomic-embed-text`, `mxbai-embed-large`, `all-minilm` — English-
centric, Lao degrades to byte-level fallback. If you reach for one, stop and raise it.

### Sidecars (Python 3.12, inside their containers)
```bash
# in services/lao-nlp or services/docx-extractor container
uvicorn app.main:app --host 0.0.0.0 --port 7731 --reload
```

---

## Architecture

```
apps/web (Next.js 15, host :3000)
   │  fetch / SSE  — talks ONLY to rag-api
   ▼
services/rag-api (Bun + Elysia, host :7730)
   ├── Ollama            host :11434   (bge-m3 embeddings, qwen3/gemma3 generation)
   ├── lao-nlp           cont :7731    (LaoNLP segment / chunk / spellcheck / normalize)
   ├── docx-extractor    cont :7732    (python-docx → typed block stream)
   └── PostgreSQL 16     cont :5432    (pgvector halfvec + HNSW, pg_trgm, FTS over content_seg)
```

- **`apps/web`** — `src/features/{chat,ingest,review,qa,glossary,eval,export}/`. RSC shell +
  client streaming components. The Studio (`/studio/*`) is the dataset factory; `/chat` is both
  product and curation surface (Promote-to-dataset, Report-wrong close the loop).
- **`services/rag-api`** — `src/features/{ingest,search,chat,dataset,eval,lao}/`. Owns all
  inference, retrieval, and DB access. Hybrid retrieval = dense (HNSW over `content_norm`
  embeddings) + lexical (FTS over `content_seg`) fused with **RRF (k=60, do not tune before the
  eval set exists)**.
- **`packages/db`** — Drizzle schema + migrations, the single source of truth for DB shape
  (except the HNSW index, decision 3). Also the tenant-scoped query helpers.
- **`packages/contracts`** — zod schemas shared web ↔ api. Validate at every boundary.
- **`packages/ui`** — shared components + Phetsarath OT font wiring.
- **`services/lao-nlp` / `services/docx-extractor`** — pure Python sidecars. Stateless. No DB.

### The dataset factory (why the pipeline is shaped this way)
`.docx → docx-extractor (typed blocks, structure preserved) → chunker (heading-aware, tables
atomic, account rows isolated) → lao-nlp /segment (content_norm, content_seg) → rag_chunk
(review='pending', embedding=NULL) → Ollama bge-m3 embed (idempotent, resumable, concurrency-
capped) → human review (/studio/review) → QA/glossary curation → versioned immutable export`.

Retrieval-affecting failure modes, in the order to suspect them if recall is bad:
(1) segmentation quality, (2) chunk boundaries, (3) embedding model adequacy for Lao.

---

## Non-negotiable data invariants (enforce in SQL, not in comments)

- **A chunk that is `review='rejected'` never appears in retrieval and never exports.**
- **A `lao_qa_pair` cannot export unless `citation_ids` is non-empty and every id references a
  non-rejected chunk.** An uncited accounting claim is a liability.
- **Exports contain `verified = true` rows only.** Unverified LLM drafts never leave the building.
- **Train/test split is by source document, never by row** — QA pairs from one document must not
  straddle splits, or the eval leaks. `qa_test.jsonl` is held out and never used for tuning.
- **`license = 'client-confidential'` rows are excluded from any shareable export** — in the query.
- **Every export is immutable and versioned** (`datasets/lao-accounting/vX.Y.Z/`) with a
  `MANIFEST.json` carrying a sha256 per file, plus a `DATA_CARD.md` (provenance, authority,
  effective dates, known gaps, intended use).
- **Chart-of-accounts rows and glossary terms are `verified = false` until a human clicks.**
  Extraction proposes; a person disposes.

## Retrieval / performance rules

- The dense CTE's `EXPLAIN (ANALYZE, BUFFERS)` must show `Index Scan using
  rag_chunk_embedding_hnsw`. A `Seq Scan` there means the tenant predicate defeated the ANN index
  — **report it, do not paper over it.** Measure **recall under the tenant filter**, not latency
  alone (iterative-scan caps can starve candidates for a sparse tenant).
- Budget: **p95 retrieval < 150 ms at 200k chunks.**
- **Build HNSW after bulk load** (decision 3). Embedding batch size 32, `OLLAMA_EMBED_CONCURRENCY`
  default 4 — never saturate the box; chat shares the same Ollama.
- **Tables are atomic chunks** — never split a table; a table over 400 tokens is emitted whole.
  **Never split a Lao sentence** — a bisected Lao sentence is unembeddable.

---

## Process — approval-gated phases

Stop at every `🚦 GATE` in `PROMPT.md`. Print the gate checklist, then **wait for explicit
approval before starting the next phase.** Do not proceed on your own initiative.

**No placeholder code.** No `// ... rest of implementation`. Every file written is complete and
runnable. A scaffold package may be intentionally minimal, but it must typecheck and run.

Gate ledger:
- **GATE 0 (Phase 0, scaffold):** `docker compose up` green; `bun run typecheck` passes. ← current
- GATE 1 → 8: see `PROMPT.md` §6.
