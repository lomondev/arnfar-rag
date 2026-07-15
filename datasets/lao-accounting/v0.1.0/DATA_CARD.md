# Data Card — arnfar-lao-accounting v0.1.0

Generated: 2026-07-13T06:51:43.614Z

## Intended use
Retrieval + supervised fine-tuning for a **Lao accounting** assistant. Lao text is
preserved byte-for-byte; English glosses are alongside, never instead of. Not legal
advice; verify against the cited source and its effective date.

## Contents
| File | Records |
|---|---|
| chunks.jsonl | 12 |
| glossary.jsonl | 4 |
| chart_of_accounts.jsonl | 5 |
| qa_train.jsonl | 4 |
| qa_dev.jsonl | 0 |
| qa_test.jsonl (held out) | 0 |
| eval_set.jsonl | 0 |

## Provenance & authority
- **Chart of Accounts (synthetic)** (coa) — authority: n/a, effective: n/a, license: internal
- **HEIMS Presentation** (sop) — authority: n/a, effective: n/a, license: internal

## Guarantees
- Only `verified = true` glossary, chart-of-accounts, and QA rows are included.
- Rejected chunks are excluded from retrieval and export.
- Every QA pair has a non-empty citation set referencing non-rejected chunks.
- Train/dev/test are split **by source document** — QA from one document never straddles splits.
- `client-confidential` rows are excluded from shareable exports.

## Known gaps
- none recorded

## Integrity
Each file's sha256 is recorded in `MANIFEST.json`. This version is immutable.
