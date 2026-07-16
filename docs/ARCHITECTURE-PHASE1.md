# Phase-1 Architecture — Accounting AI Assistant

How the repo implements [ERP-RAG-VISION.md](../ERP-RAG-VISION.md) Phase 1, what each
vision requirement maps to, and the roadmap to the multi-domain A2A system.
Companion to [CLAUDE.md](../CLAUDE.md) (hard constraints) and [PROMPT.md](../PROMPT.md)
(phase-gated build spec) — both still govern; this document does not relax them.

## System shape

```
apps/web (Next.js 15, :3000)
   │  fetch / SSE — talks ONLY to rag-api
   ▼
services/rag-api (Bun + Elysia, :7730)
   ├── /agent/*        A2A entry point: domain routing + role personas + tools
   ├── /tools/*        deterministic agent tools (CoA, glossary, VAT, doc search)
   ├── /chat           streaming RAG chat with conversation persistence
   ├── /search         hybrid retrieval (dense HNSW + lexical FTS, RRF k=60)
   ├── /ingest /review /qa /glossary /accounts /export /eval /lao
   ├── Ollama :11434   bge-m3 embeddings · SEA-LION generation · qwen judge
   ├── lao-nlp :7731   segment / normalize / spellcheck (Python sidecar)
   ├── docx-extractor :7732
   └── PostgreSQL 16   pgvector halfvec(1024) + HNSW · pg_trgm · FTS
```

## Vision requirement → implementation

| Vision item | Where it lives today |
|---|---|
| Modular RAG domains | `src/domains/registry.ts` — per-domain collections, retrieval params, tools, roles, prompt preamble. `accounting` active; 20 ERP domains registered as `planned`. |
| A2A orchestration | `src/features/agent/` — `POST /agent/ask {question, domain?, role?}`. Phase 1 routes to the single active domain; the dispatcher point is marked for the multi-domain classifier. |
| Roles (accountant → financial analyst) | `src/domains/roles.ts` — 8 personas. A role changes tone/structure only; cite-or-abstain and verified-glossary rules bind every role. |
| AI tools | `src/features/tools/` — `coa_search`, `glossary_lookup`, `vat_calc` (BigInt LAK, basis-point rates, half-up to the kip), `doc_search`. Tool selection is deterministic (pattern-based), not LLM-driven — local models are unreliable tool-callers and a silent wrong call is worse than none. |
| Knowledge base / vector DB | PostgreSQL 16 + pgvector `halfvec(1024)` + HNSW (built post-bulk-load, decision 3). Chosen over Qdrant/Milvus/etc. because retrieval, tenancy, FTS, and transactional metadata live in ONE store — no sync problem. Revisit only past ~10M chunks. |
| Embedding model | bge-m3 via Ollama (multilingual, handles Lao; forbidden list in CLAUDE.md). E5/Nomic/Jina/OpenAI/Voyage rejected: English-centric, cloud-only, or unverified Lao support — and cloud calls violate the local-first rule. |
| Document ingestion | `src/features/ingest/` — docx → typed blocks → heading-aware chunker (tables atomic) → lao-nlp segmentation → resumable embed jobs (`SELECT … FOR UPDATE SKIP LOCKED`). OCR/PDF/XLSX/web: roadmap. |
| Metadata schema | `rag_document` (collection, authority, effective_date, supersededBy, license, lang, sha256) + `rag_chunk` (kind, heading_path, review state, tenant columns denormalized). Fiscal-year/industry fields: add when a document needs them, not before. |
| Retrieval strategy | Hybrid dense+BM25 with RRF (k=60, frozen until eval says otherwise), glossary query expansion, tenant filter inside every CTE. Reranking (bge-reranker-v2-m3) and parent-child retrieval: Phase 6/7 roadmap. |
| Prompt templates | `src/features/chat/prompt.ts` (shared rules: Lao-first, cite-or-abstain, integer LAK, exact account codes) + domain preambles and role personas layered on top. |
| Evaluation | `src/features/eval/` — 19 runs to date; cross-family judging (qwen judges Gemma-based generator) per decision 4. |
| Version control of knowledge | Immutable versioned exports `datasets/lao-accounting/vX.Y.Z/` with MANIFEST sha256s + DATA_CARD. |
| Security / multi-tenancy | `hf_id → company_id → branch_id` denormalized on every table, enforced in every WHERE. Dev seeds one tenant; user/document permissions and audit UI: roadmap (outbox_event is the audit log substrate). |
| Knowledge graph | Not built. The FK chain (document → chunk → qa citation; account parent_code hierarchy) is the seed; a real graph layer is roadmap, after the ERP transactional modules exist. |

## The A2A contract

`POST /agent/ask` is the stable seam. Response:

```json
{
  "domain": "accounting",
  "role": "tax_advisor",
  "answer": "…[1]…",
  "citations": [{ "n": 1, "id": "…", "title": "…", "content": "…" }],
  "toolCalls": [{ "tool": "coa_search", "input": { "q": "1011" }, "result": [ … ] }]
}
```

Adding a domain later: flip its registry entry to `active`, point it at its
collections, give it tools. The orchestrator gains a classifier that picks
domain(s) per question and can fan out to several domain agents and merge —
callers never change.

## Non-negotiables carried into every future domain

- Local-first: Ollama only, no cloud LLM calls in the runtime path.
- LAK is a BigInt everywhere; literals preserved from extraction.
- Lao is never machine-translated; `content` is byte-for-byte immutable.
- Embed `content_norm`, never `content_seg`.
- Tenant predicate on every query; verified-only, cited-only exports.

## Roadmap (in order)

1. **Corpus growth** — more Lao accounting/tax documents; unlocks real
   train/dev/test splits (split is by document; one document = no test set).
2. **PDF + OCR ingestion** for circulars and scanned regulation.
3. **Reranker** (bge-reranker-v2-m3 in lao-nlp) once the eval set can measure it.
4. **Second domain** (lao-tax or ifrs) — proves the registry seam; then the
   orchestrator gets its domain classifier (A2A proper).
5. **ERP transactional tools** (journal/ledger/trial-balance lookups) — these
   need the ERP DB, not the RAG store; they arrive with the ERP integration.
6. **Knowledge graph** over customers → invoices → journals → statements.
7. **AuthN/Z + per-document permissions + audit surface** before any
   multi-user deployment.
