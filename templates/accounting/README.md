# Accounting dataset templates

Ready-to-fill templates for the **accounting** domain (Phase 1). Fill them with your
real content, then load them into the running stack. They map 1:1 to the rag-api
endpoints and DB schema, so what you author here is exactly what the assistant retrieves.

See the format guide for the wider picture: the 5 formats reused across all 25 ERP domains.

## Files

| File | Format | Loads into | Endpoint |
|---|---|---|---|
| `chart-of-accounts.csv` | F2 — master data | `lao_account` | `POST /accounts/` |
| `glossary.csv` | F4 — glossary | `lao_term` | `POST /glossary/` |
| `qa.jsonl` | F5 — QA pairs | `lao_qa_pair` | `POST /qa/` |
| `knowledge/*.md` | F1 — narrative | `rag_chunk` (via ingest) | `POST /ingest/docx` |
| `load.ts` | loader | — | reads the three above |

## Load them

```bash
bun run start                        # ensure the stack is up (rag-api on :7730)
bun run templates/accounting/load.ts # creates accounts + terms + QA
```

Everything is created **unverified** (extraction proposes, a human disposes). Review and
accept in `/studio/accounts`, `/studio/glossary`, `/studio/qa`. Re-running the loader is
safe — existing accounts/terms return "already existed" (409) and are skipped.

Set `RAG_API_URL` if rag-api is not on `http://localhost:7730`.

## Column specs (must match these enums)

### chart-of-accounts.csv
`code, name_lo, name_en, parent_code, class, normal_balance, statement`

- **class** — `asset` · `liability` · `equity` · `revenue` · `expense`
- **normal_balance** — `debit` · `credit`  (asset/expense = debit; liability/equity/revenue = credit; contra-accounts flip)
- **statement** — `BS` (balance sheet) · `PL` (profit & loss) · `CF` (cash flow) · `NONE`
- **parent_code** — leave empty for top-level; else the `code` of the parent account
- Codes should match **your** official Lao chart of accounts. The sample uses the
  French/Lao decimal plan (classes 1–7); replace with your real codes.

### glossary.csv
`term_lo, term_en, definition_lo, definition_en, variants_lo, forbidden_lo`

- **term_en** is required (never leave blank).
- **variants_lo** — spelling variants, so retrieval still matches. Separate multiple with `|`.
- **forbidden_lo** — wrong-but-common terms the assistant must never use. Separate with `|`.
- Fields containing a comma must be wrapped in `"double quotes"`.

### qa.jsonl  (one JSON object per line)
`question_lo, answer_lo, citation_query, citation_ids, tags, difficulty, source`

- **Every QA pair must cite a chunk.** Provide either:
  - `citation_ids`: real chunk UUIDs (find them via `POST /search/` or `/studio/review`), or
  - `citation_query`: a natural-Lao phrase — the loader searches your corpus and cites the
    top hit. It prints what it resolved; **verify the citation is actually correct.**
- **difficulty** — 1 (easy) … 5 (hard). **source** — `human` or `chat_promoted`.
- After loading, run `POST /qa/assign-splits` to assign train/dev/test **by document**.

### knowledge/*.md
Front-matter (`collection, authority, effective_date, doc_type, lang, license, version`)
+ heading-structured Lao prose. **Note:** rag-api ingests `.docx` only today — author in
Markdown, then Save As `.docx` and upload through `/studio/review` (or `POST /ingest/docx`).

## Golden rules (what keeps answers correct)

1. **Clean Lao** — no spaces inside a word, no doubled vowels (`ທີີ່`). These silently break retrieval.
2. **Tables are atomic** — one accounting line = one row. Never split a code from its description.
3. **Cite or abstain** — a QA pair with no citation never exports.
4. **Verified only** — nothing leaves the building until a human clicks accept.
5. **LAK is an integer** — amounts are whole kip (`BIGINT`), never a float, never rounded.
6. **Lao stays Lao** — English glosses sit alongside, never replace the Lao.
