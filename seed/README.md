# Lao accounting seed corpus

Synthetic-but-realistic test data for exercising the whole platform end to end —
ingest → chunk → segment → embed → hybrid retrieval → chat → QA → export — without
touching a real client document.

> **This is test data, not an authoritative source.** Rates, brackets, useful lives and
> account codes are plausible for Lao PDR but have **not** been verified against the
> current law. Every seeded document is ingested with
> `authority = "ຂໍ້ມູນຕົວຢ່າງ SEED — ບໍ່ແມ່ນເອກະສານທາງການ"` so that any citation the
> assistant produces says out loud that it came from seed data. Do not ship a dataset
> export built on it, and do not remove that authority marker.

## Load it

```bash
bun run start          # stack up: postgres + sidecars + rag-api on :7730 + ollama
bun run seed           # or: bun run seed/load.ts
```

Takes a few minutes — most of it is bge-m3 embedding the ~12 documents. The loader
waits for each embed job before loading QA, because QA citations are resolved by
searching the corpus and searching before the vectors land gives lexical-only hits.

Re-running is safe: documents dedupe on `content_sha256`, accounts and terms return
409 and are skipped, and QA is skipped automatically if the tenant already has pairs.

### Flags

| Flag | Effect |
|---|---|
| `--skip-knowledge` / `--skip-accounts` / `--skip-glossary` / `--skip-qa` | load only part of it |
| `--no-wait` | do not wait for embeddings (QA citations degrade to lexical hits) |
| `--verify` | auto-accept accounts, terms and QA — for testing export without clicking through the Studio |
| `--force-qa` | load QA even though the tenant already has pairs (will duplicate) |
| `--assign-splits` | run `POST /qa/assign-splits` at the end (train/dev/test by document) |

`RAG_API_URL` overrides `http://localhost:7730`.

## What's in it

| File | Format | Rows | Lands in |
|---|---|---|---|
| `chart-of-accounts.csv` | F2 | 96 accounts, classes 1–7 with parent hierarchy | `lao_account` |
| `glossary.csv` | F4 | 45 Lao↔EN terms with variants and forbidden forms | `lao_term` |
| `qa.jsonl` | F5 | 41 QA pairs, difficulty 1–5, citation resolved by search | `lao_qa_pair` |
| `knowledge/*.md` | F1/F3 | 12 documents across 3 collections | `rag_document` + `rag_chunk` |
| `knowledge/index.json` | — | per-file ingest metadata (collection, title) | — |

Front-matter in the `.md` files is author notes only — the ingester skips it. The real
ingest metadata lives in `knowledge/index.json` and is sent as form fields, which is the
only way it reaches `rag_document` (see `docs/DATA-FORMAT-STANDARD.md`).

### Knowledge documents by collection

| Collection | Documents |
|---|---|
| `tax` | `vat.md`, `profit-tax.md`, `payroll-income-tax.md`, `social-security.md` |
| `lao-accounting-law` | `depreciation.md`, `financial-statements.md`, `inventory-costing.md` |
| `sop` | `journal-entries.md`, `invoice-and-documents.md`, `period-close.md`, `bank-reconciliation.md`, `currency-and-fx.md` |

All three collections are in the `accounting` domain's retrieval set
(`services/rag-api/src/domains/registry.ts`), so chat reaches them by default.

## What it is built to exercise

- **Chunking** — heading-heavy prose, GFM tables that must stay atomic, numbered
  procedures, fenced formula blocks, and one document (`journal-entries.md`) that is
  nothing but worked transactions.
- **Lao segmentation and hybrid retrieval** — every question in `qa.jsonl` is natural
  Lao whose answer lives in exactly one section, so a bad `content_seg` or a bad chunk
  boundary shows up as a wrong citation.
- **Cross-document reasoning** — VAT appears in `vat.md`, in the journal entries, and in
  the inventory-costing rule that input VAT stays out of inventory cost. A retrieval
  regression collapses these into one another.
- **Account-code grounding** — glossary terms, chart-of-accounts codes and the codes
  used inside the knowledge tables all agree, so a wrong code in an answer is detectable.
- **Export invariants** — nothing is verified by default, so `POST /export` should
  produce an empty dataset until a human accepts rows (or you pass `--verify`).

## Removing it

The seed is ordinary tenant data — there is no separate namespace. Delete documents
individually in `/studio/review` (`DELETE /ingest/documents/:id`, `?force=1` when QA
pairs cite them), or reset the whole dev database with `bun run reset`.
