# Claude Code Build Prompt — Arnfar AI: Lao Accounting RAG + Dataset Platform

> Model routing: `opusplan` (Opus for planning/design, Sonnet for code execution).

---

## 0. Mission

Build a **local-first, offline-capable Lao accounting AI assistant** whose **primary deliverable is a curated, exportable Lao accounting dataset**, and whose secondary deliverable is a chat product that consumes and QAs that dataset.

Source of truth: a corpus of **Microsoft Word (.docx)** documents containing Lao accounting material — accounting law, chart of accounts, journal-entry procedures, tax rules, VAT, payroll, financial-statement formats, internal SOPs.

Two products fall out of one pipeline:

| Product | Description |
|---|---|
| **`arnfar-accounting-dataset`** | Versioned, licensed, exportable dataset: cleaned chunks, curated Lao↔English accounting glossary, QA pairs, SFT JSONL, eval set. This is the asset. |
| **`arnfar-ai-chat`** | Next.js chat UI + RAG API. Answers Lao accounting questions with citations. Also the *curation surface* used to build the dataset. |

**The chat UI is not the goal. It is the tool that makes the dataset good.** Build order reflects this.

---

## 1. Hard constraints — do not violate, do not ask again

**Stack**
- TypeScript strict mode everywhere. No implicit `any`. No `as any`.
- **Drizzle ORM only.** Never Prisma.
- PostgreSQL 16 + **pgvector ≥ 0.8**.
- Bun + Elysia for the API service. Next.js 15 App Router for UI.
- Python 3.12 + FastAPI **only** for the Lao NLP sidecar and the docx extractor. Nowhere else.
- Ollama for all inference. **No cloud LLM calls anywhere in the runtime path.**
- Feature-based folder structure.

**Money & numbers**
- LAK is **always** an integer. `BIGINT` in Postgres, `bigint` in TypeScript, `i64` in Rust. **Never** `float`/`f64`/`number` for currency.
- Any monetary amount extracted from a document is stored as `BIGINT` minor-unit-free LAK plus the original literal string. Never round.

**Multi-tenancy**
- Hierarchy `hf_id → company_id → branch_id` enforced **at the query level on every table**. Every RAG table carries `hf_id` and `company_id` denormalized. No exceptions, no "we'll add it later".

**Lao language**
- **Phetsarath OT** for all Lao script rendering, UI and exports.
- **Never machine-translate Lao text.** Lao stays Lao. English glosses are added *alongside*, never *instead of*.
- Original document text is preserved byte-for-byte in `content`. Normalization output lives in a separate column.

**Integrity**
- Transactional outbox for every RabbitMQ publish. **Never publish inside a DB transaction.**
- UUIDv7 for all cross-service identifiers.
- No `unwrap()` outside tests (if any Rust appears).
- Next.js **never** calls Ollama or the Python sidecars directly. Only `arnfar-rag-api`.

**Process**
- **Approval-gated phases.** Stop at every `🚦 GATE`. Print the gate checklist, wait for explicit approval. Do not proceed on your own initiative.
- No placeholder code. No `// ... rest of implementation`. Every file you write is complete and runnable.

---

## 2. Target architecture

See README.md for the diagram and the repo layout (Bun workspaces monorepo).

---

## 3. Models — pull these, verify before trusting

```bash
ollama pull bge-m3          # embeddings, 1024-dim, multilingual. NON-NEGOTIABLE for Lao.
ollama pull qwen3:8b        # generator — best Lao among small open models
ollama pull gemma3:12b      # generator alternative — bench both in Phase 6
```

**Forbidden embedding models:** `nomic-embed-text`, `mxbai-embed-large`, `all-minilm`.
They are English-centric; Lao falls to byte-level fallback and recall silently collapses.

Phase 6 decides `qwen3:8b` vs `gemma3:12b` empirically on the Lao accounting eval set.

---

## 4. Database schema

The canonical schema is specified in the original build prompt and is implemented in
`packages/db` (Drizzle → single source of truth). See CLAUDE.md for the intentional
exception: the HNSW index is created by a post-load management command, NOT in the
declarative migration.

### The one idea that makes Lao RAG work

Lao has **no spaces between words**, so `to_tsvector` cannot tokenize it and lexical/BM25
search is dead on arrival. Fix: run LaoNLP segmentation, store the result in `content_seg`
(`ໜີ້ ສິນ ໝູນ ວຽນ ...`), and build the `tsvector` over **that**. Queries go through the
identical segmentation before hitting `fts`. `content` stays pristine for display and for the
LLM prompt. The dense embedding is built from `content_norm` (natural Lao) — **never** from
`content_seg`.

---

## 5. Hybrid retrieval (RRF)

RRF constant `60` (published default). Do not tune before the eval set exists.
`EXPLAIN (ANALYZE, BUFFERS)` must show `Index Scan using rag_chunk_embedding_hnsw` inside the
dense CTE under the tenant filter. Budget: p95 retrieval < 150 ms at 200k chunks.

---

## 6. Phases — stop at every gate

- **Phase 0** — Scaffold + CLAUDE.md. 🚦 GATE 0: `docker compose up` green; `bun run typecheck` passes.
- **Phase 1** — `services/lao-nlp` (FastAPI :7731). 🚦 GATE 1: segmentation eyeballed on real Lao.
- **Phase 2** — `services/docx-extractor` (FastAPI :7732). 🚦 GATE 2: block/heading/account-row extraction verified by hand.
- **Phase 3** — Ingestion pipeline + Studio review UI. 🚦 GATE 3: full corpus ingested, ~100 chunks reviewed.
- **Phase 4** — Hybrid retrieval + search API. 🚦 GATE 4: HNSW usage proven, p95 shown, 10 real queries.
- **Phase 5** — Dataset tooling (qa/glossary/export). 🚦 GATE 5: produce v0.1.0, spot-check 30 QA pairs.
- **Phase 6** — Eval harness (GO/NO-GO). 🚦 GATE 6: recall@5 ≥ 0.70, faithfulness ≥ 0.80, abstention ≥ 0.90, p95 < 150 ms.
- **Phase 7** — Chat API + Chat UI. 🚦 GATE 7: live demo, Lao, working citations.
- **Phase 8** — `POST /lao/check`. 🚦 GATE 8: ship.

---

## Decisions taken at Phase 0 (see CLAUDE.md for rationale)

1. **RabbitMQ dropped** for the local-first single-node deployment. The pipeline uses a
   Postgres job table with `SELECT ... FOR UPDATE SKIP LOCKED`; `outbox_event` is kept as an
   append-only audit/event log. Resumability comes from `WHERE embedding IS NULL`.
2. **Object storage = local filesystem volume** (`storage/`) behind a storage interface,
   swappable to S3/MinIO later.
3. **Dense embedding is built from `content_norm`**, never `content_seg`.
4. **HNSW index is built post-load** by a management command, not in the declarative schema.
5. Reranker (`bge-reranker-v2-m3` cross-encoder in the sidecar) and cross-model LLM-judging
   are the plan for Phase 6/7 — no code at Phase 0.
