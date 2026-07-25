# Arnfar ERP — 90-day roadmap (plan of record)

_Adopted 2026-07-25. One sentence: **the platform is ahead of the data — fill the factory,
put real accountants on it, then connect live ERP data.**_

## Phase 1 — Foundation (week 1) ✅ started 2026-07-25

- [x] Nightly backup cron (02:00 → `backups/`, keep 14) + low-disk guard in `scripts/backup.sh`
- [x] Real corpus restored (292 chunks, embeddings intact) and retro-cleaned
- [ ] Restore drill documented: `./scripts/backup.sh restore <dump>` → scratch DB → per-table copy
- Rule going forward: **no more full wipes** — deletions are surgical (the tools support it)

## Phase 2 — Dataset sprint (weeks 2–5)

Targets, using only tools that already exist:

| Asset | Now | Target | Tool |
|---|---|---|---|
| Verified QA pairs | ~15 | **300–500** | `/studio/teach` (edit-then-approve is the habit) |
| Knowledge kinds | 2 seeded | **~10** | `/studio/knowledge` |
| Verified glossary terms | ~15 | **~150** | `/studio/glossary` (variants + forbidden forms) |
| Real documents ingested | 1 | all core MoF/company docs | `/studio/ingest` (born-clean, titled) |

**Quality bar (the un-passed GATE 6, on real data):** recall@5 ≥ 0.9, faithfulness ≥ 0.8
(`/studio/eval`; judge must be cross-family — pull `qwen3:8b`). Measure weekly; never tune
on `qa_test`.

Working loop: every question in the `/studio` gaps queue gets teach-answered or a knowledge
entry the same week. 2–3 phrasings per important fact; difficulty spread 1–5.

## Phase 3 — Real users + live ERP data (weeks 6–9)

- 2–3 real accountants using `/chat` daily (their questions feed the gaps queue — the flywheel)
- **Live-ERP read-only tools** behind `features/agent` + `features/tools`:
  account balance, customer/vendor outstanding, invoice lookup, trial balance.
  A document bot answers "what is the VAT rate"; an ERP assistant answers
  "ລູກຄ້າ B ຄ້າງຊຳລະເທົ່າໃດ?" from the live database. Read-only first; tenant-scoped;
  every answer still cites (tool result = the citation).
- Positioning: **local-first is the pitch** — client accounting data never leaves the machine.

## Phase 4 — Domain expansion by pull (weeks 10–13)

Activate exactly **one** new domain from `domains/registry.ts` — the one the gaps queue
shows users asking about (expected: Lao Tax/VAT). Entry bar per domain: its own kinds,
entries, ~100 verified QA, eval pass. Never activate more than one at a time.

## Anti-goals

- No new Studio features until Phase 2 targets are met
- No fine-tuning below ~1,000 verified QA (retrieval fixes beat it; export is already SFT-ready)
- No multi-domain activation before the accounting bar is passed
