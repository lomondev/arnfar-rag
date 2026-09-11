# How to improve Arnfar AI — evidence-based plan

_Drafted 2026-08-26 against `feat/production-readiness`, from the live database, not from the docs._
_Supersedes the priority ordering in [`MULTI-MODEL-PLAN.md`](./MULTI-MODEL-PLAN.md), which survives
as Tier 4 here._

**One sentence: the platform is excellent and the numbers describing it are not real yet.
Fix what makes them real before building anything new.**

---

## What the database actually says

```
corpus        100 chunks · 12 documents · 3 collections (sop 43, tax 34, law 23)
QA            41 verified pairs — train 29 / dev 4 / test 8
glossary      36 verified · 610 UNVERIFIED
knowledge     0 kinds
usage         15 conversations · 34 user messages
```

Last `hybrid-rrf` run (2026-08-25, n=41):

| Metric | Value | Gate | Reading |
|---|---|---|---|
| recall@5 | 0.9268 | ≥ 0.90 | passes — but see T0.3 |
| hit@5 | 0.9268 | — | — |
| nDCG@10 | 0.8088 | — | the ordering signal |
| MRR | 0.7699 | — | **ceiling is 0.9268** |
| precision@5 | 0.1854 | — | at ceiling (1 citation/pair → max 0.2); carries no information |
| faithfulness | **NULL** | ≥ 0.80 | **never measured, not once** |
| p95 retrieval | 8 ms | < 150 ms | 142 ms unspent |

---

## Tier 0 — Make the numbers mean something

Nothing below Tier 0 is worth doing first, because until these are fixed you cannot tell whether
a change helped.

### T0.1 · The entire corpus is seed data

All 12 documents carry `authority = ຂໍ້ມູນຕົວຢ່າງ SEED — ບໍ່ແມ່ນເອກະສານທາງການ`
("sample data — not an official document"). **There is not one real MoF document in the system.**

Every metric above therefore describes a closed synthetic loop: seed documents → QA pairs written
against those same seed documents → retrieval scored on those pairs. recall@5 = 0.927 proves the
*plumbing* works. It says nothing about whether a Lao accountant gets a correct answer.

### T0.2 · The real corpus was wiped and never came back

`docs/ROADMAP.md` Phase 1 records "Real corpus restored (292 chunks, embeddings intact)". The
database holds 100 chunks, all seed. The backup sizes tell the story:

```
Aug 14–23   44–46 KB   ← near-empty database, every night, for ten days
Aug 23 22:53   555 KB   ← seed data loaded
Aug 26         593 KB   ← today
Aug 10 14:56   2.2 MB   ← pre-wipe-20260810-145643.dump
```

That 2.2 MB dump is a valid full custom-format dump containing `rag_chunk`, `rag_document`,
`lao_qa_pair`, `lao_term`, `knowledge_kind` and the ERP schema. **It is very likely the only
surviving copy of the real corpus**, and it has been sitting one wipe away from gone for 16 days.

`docs/ROADMAP.md` Phase 1 also has this item still unchecked:

> - [ ] Restore drill documented: `./scripts/backup.sh restore <dump>` → scratch DB → per-table copy

**Do the restore drill now, on this dump, into a scratch database.** It simultaneously closes the
unchecked ROADMAP item, verifies the backups are restorable at all, and tells you whether the real
corpus is recoverable. This is the highest-value hour available anywhere in this document.

### T0.3 · The eval harness ignores the train/test split

`features/eval/runner.ts:70-77` selects QA pairs filtering on `verified` only. The `split` column
is populated (train 29 / dev 4 / test 8) and **nothing reads it**. Consequences:

1. **71% of the "gate" number is measured on training data.** 0.9268 is optimistically biased.
2. **`qa_test` is consumed on every single run** — which CLAUDE.md forbids outright:
   *"`qa_test.jsonl` is held out and never used for tuning."*

The splits themselves are clean — I checked, and no source document straddles two splits, so the
`by source document, never by row` invariant holds. **This is a ~5-line fix**: add a `split` filter
to the config, default the gate run to `dev`, and make `test` opt-in and logged.

> This is a stated non-negotiable invariant with no test guarding it. Per CLAUDE.md's own rule
> — *"do not add a new invariant without a test that would fail without it"* — the fix ships with
> a test.

### T0.4 · The eval questions are space-segmented; real users don't type that way

```
ຄິດໄລ່ ອາກອນມູນຄ່າເພີ່ມ ຕ້ອງ ຊຳລະ ສຸດທິ ແນວ ໃດ
     ↑        ↑          ↑      ↑      ↑     ↑   spaces between every word
```

Real Lao is written without spaces between words. CLAUDE.md already flags this for the corpus
("the seeded corpus was authored space-segmented, and the generator copies the register of its
context"), but the **questions** have it too — so the lexical arm is matching pre-segmented input
against `content_seg` and getting a free ride that no real query gets. Train/serve skew, and it
inflates recall.

Fix: strip the spaces from `question_lo` (or store an unsegmented variant) and let
`lao-nlp /segment` do the segmentation the production path does. Then re-measure. **Expect the
number to go down. That is the point.**

### T0.5 · Every vector has unknown provenance

```sql
SELECT embed_model, count(*) FROM rag_chunk GROUP BY 1;
 embed_model | count
-------------+-------
             |   100     ← all NULL
```

100 chunks embedded, zero labelled. `assertEmbeddingProvenance()` refuses to serve in production
on this state. One command, no re-embedding: **`bun run db:reembed --stamp`**.

### T0.6 · Eight test questions cannot support a gate claim

A test split of 8 gives roughly ±15 percentage points of sampling error. Even a perfectly honest
0.93 on `n=8` is indistinguishable from 0.78. The gate needs volume before it means anything —
see Tier 3.

---

## Tier 1 — Measure the half you have never measured

### T1.1 · Take a faithfulness baseline

Every run so far used `generate: false` (`features/eval/runner.ts:46`), so only retrieval was
scored. **Half of GATE 6 has never been run.** Until it is, "are the answers good?" has no baseline
and no improvement to it is provable.

Cost: 41 queries × (9B answer + 8B judge) ≈ 25–40 min on the GTX 1080. Judge is `qwen3:8b`,
already cross-family against the Gemma-based generator, as decision 4 requires.

### T1.2 · Run the reranker arm — it has never once executed

```
$ curl localhost:7731/health
{"rerank": false, "rerank_model": null}
$ curl -X POST localhost:7731/rerank …   →  503
```

`hybrid-rrf+rerank` is written, wired into the harness, and has **never run**, because `lao-nlp`
is the default image. Decision 4 says it earns the chat path by winning a run. It has never been
given the chance.

Build: `LAO_NLP_RERANKER=1 docker compose up -d --build lao-nlp` (~2.5 GB weights, one time).

---

## Tier 2 — The quality levers, in the order the evidence supports

### T2.1 · Promote the reranker to `/chat` (if T1.2 wins)

**MRR 0.7699 against a ceiling of 0.9268** is the finding. Recall says the gold chunk is in the
top 5 for 93% of questions; MRR says that for roughly a quarter of them it is *not at the top*,
and the generator reads all 5–8 sources with equal billing. CLAUDE.md predicted this precisely:

> nDCG@10 is the one to watch when recall is already high and answers are still wrong — recall
> cannot tell rank 1 from rank 10, and a 5-chunk context window very much can.

The standing latency objection is weaker than it looks: **150 ms is the `/search` budget, not the
`/chat` budget.** On `/chat`, 9B generation already costs ~20 s, so 2–3 s of CPU cross-encoding is
~15% for a directly better-ordered context. Proposal: **promote on `/chat`, keep it off `/search`**,
where sub-150 ms *is* the product.

### T2.2 · Verify the glossary — 610 unverified against 36 verified

Verified terms are load-bearing twice over: they are injected into the system prompt
(`chat/service.ts` `glossaryForPrompt`, filtered on `verified = true`) **and** they drive query
expansion (`search/glossary.ts`). 610 terms are sitting in the table doing nothing for either.

This is the best effort-to-impact ratio in the whole document: it is human clicking in
`/studio/glossary`, not engineering, and it improves retrieval and answer terminology at once.

### T2.3 · Create knowledge kinds — there are zero

`knowledge_kind` is empty; ROADMAP targets ~10. Kinds scope retrieval in both `/chat` and
`/search`, so with none defined the filters in the UI have nothing to filter.

---

## Tier 3 — Volume, which is the actual blocker

`docs/ROADMAP.md` says it plainly and the database agrees: *the platform is ahead of the data.*

| Asset | Now | Target | Tool |
|---|---|---|---|
| Verified QA pairs | **41** | 300–500 | `/studio/teach` |
| — of which `test` | **8** | ~60+ | (split by document) |
| Knowledge kinds | **0** | ~10 | `/studio/knowledge` |
| Verified glossary terms | **36** (610 waiting) | ~150 | `/studio/glossary` |
| Real (non-seed) documents | **0** | all core MoF docs | `/studio/ingest` |
| Difficulty-5 QA pairs | **0** | some | `/studio/teach` |
| Daily accountant users | ~0 (34 messages total) | 2–3 | `/chat` |

**No amount of retrieval or model engineering substitutes for this row of numbers.**

---

## Tier 4 — Multi-model architecture

Full design in [`MULTI-MODEL-PLAN.md`](./MULTI-MODEL-PLAN.md). Resequenced against the evidence:

| Part | Verdict |
|---|---|
| **A** · model-role registry + GPU/CPU lane scheduler | Build it — it is the enabler for C and D, and it fixes `chat/service.ts:137`, where the UI model picker silently re-targets the query rewriter. But it is a **latency** change, not a quality one. |
| **B** · multi-query retrieval | **Demoted.** It is a recall lever and recall is 0.927. Revisit past ~1,000 chunks. |
| **C** · background cross-family verification | **Promoted** — it is the missing half of GATE 6 made continuous. Add the **repair loop**: when the verifier finds an unsupported claim, re-answer once with reranked/wider context and replace. That converts it from a warning badge into a quality lever. |
| **D** · multi-modal ingest (OCR + vision) | Keep as the volume play for Tier 3 — real MoF documents arrive as scanned PDFs, so this is how Tier 3 gets unblocked at scale. |

The hardware invariant from that document stands and governs all of it:

> The GPU is held by the `generate` role and nothing else. Every other role runs CPU-only.
> 8 GB does not fit SEA-LION 9B and an 8B judge at the same time.

---

## The order, as a checklist

```
T0.2  restore drill on pre-wipe-20260810-145643.dump    ← do this first, today
T0.5  bun run db:reembed --stamp                        ← one command
T0.3  eval respects the split (+ the test that guards it)
T0.4  de-segment the eval questions, re-measure
T1.1  faithfulness baseline                             ← first honest GATE 6 number
T1.2  build + run the rerank arm
T2.1  promote the reranker to /chat if it wins
T2.2  verify the 610 glossary terms
T2.3  create knowledge kinds
T3    volume: real documents, 300–500 QA, real users
T4    A → C(+repair) → D
```

**T0.2 through T1.1 are days of work, mostly not code, and they are worth more than every
architectural idea in Tier 4 combined** — because they are what turn "I think this helped" into
"the run says this helped."

---

# Addendum — what shipped, 2026-08-26

Built against this plan on `feat/production-readiness`. `bun run check` green throughout:
216 TS tests, 33 Python tests, lint + typecheck clean.

## 1 · Infrastructure correctness

**The eval now respects the split** (T0.3). `EvalConfig.splits` defaults to `["train","dev"]`
and `test` must be named explicitly; runs that touch it are stamped `held_out: true` in
`eval_run.params` and get a `notes` line saying so. `selectEvalPairs()` was extracted from
`runEval` purely to make the predicate testable, and
`features/eval/__tests__/splits.test.ts` fails against the old version.

**Every vector is labelled** (T0.5). `bun run db:reembed --stamp` → 100/100 chunks now carry
`embed_model = bge-m3`; `assertEmbeddingProvenance()` no longer has grounds to refuse.

## 2 · Lao + English, in and out

Language is now **resolved deterministically before generation**, not guessed by the model:
`features/lao/lang.ts` counts script characters (digits and punctuation excluded — they must
not vote on the language of the sentence around them) and Thai is detected separately, since
Lao and Thai occupy adjacent Unicode blocks.

- `answerLang: auto | lo | en | both` on the chat request and in the Studio composer.
  Deliberately **separate state from the UI chrome toggle** — otherwise a Lao reader could
  never ask for an English answer.
- `both` writes the full answer twice, `## ລາວ` then `## English`, same citations.
- **Glossary expansion is now bidirectional.** It bridged EN→LO only; a Lao query now also
  contributes the English term to the lexical arm, matched against the *unsegmented* Lao
  form because that is what a user types.
- `rag_conversation.lang` was written once at creation and read by nothing. It is now folded
  from the turns themselves and is live: `lo 1 / en 2 / mixed 17`.

**Two real bugs found by testing, not by reading:**

1. **English answers would never have streamed.** `createLaoJoiner` held every token until
   it saw six Lao runs — for an English answer, never. The whole answer arrived at
   `flush()`, so the reader watched an empty "writing" state until generation ended. Fixed
   with an explicit `expectLao` signal plus a generic character-count escape, and guarded by
   a test that fails on the old behaviour.
2. **The client never handled the `done` frame at all**, so an in-flight answer carried no
   server message id until the thread reloaded.

**The prompt had to be fixed twice.** The first English run resolved `answerLang: en`
correctly and SEA-LION answered in Lao anyway — six consecutive rules about Lao spacing,
Lao punctuation and Lao digits outweigh one rule saying English, especially with Lao context.
Fixes: drop the Lao-prose block entirely when the answer is English, switch the persona line,
and restate the language **last** in both the system prompt and the final user-prompt line —
which `buildPrompt`'s own comment already said carries the most weight. Verified:

> The standard value-added tax (ອາກອນມູນຄ່າເພີ່ມ) rate in Laos is 10% of the value of goods
> or services before tax… Output VAT (ອາກອນຂາຍອອກ) is calculated as… [1, 4]

English prose, cited, **every Lao term kept in parentheses** — glosses alongside, never
instead of. Lao regression clean: pure Lao, joiner rejoined `ອາກອນມູນຄ່າເພີ່ມ`, `ສປປ ລາວ`
spacing preserved.

## 3 · Chat history feeds the dataset

`features/qa/mine.ts` + `POST /qa/mine` harvest candidates from conversation history.
`dryRun` is the default. New provenance value `chat_mined` (migration `0006`).

**No model call anywhere in it** — mining is a join and a filter over turns that already
happened. Asking a generator to rewrite the pair would put an unreviewed model opinion into
the dataset's provenance chain, and the whole point of the label is that the text is exactly
what was said.

Rules, each with a test: mined rows are **always `verified = false`**; a turn citing only web
or ERP sources is **never proposed** (it could never export, so it would only fill the queue);
a turn is never proposed twice. Run against real history it produced **14 candidates, 0
verified**. It also proposed `"HI"` — with eight citations, because the retriever always
returns *something* — which is why there is now a question-length floor.

## 4 · Output accuracy — built, tested, and deliberately left OFF

The full loop works: answer streams → job queued on `ingest_job` (`kind='verify'`, no broker,
decision 1) → worker runs a **different model family** → verdict in `rag_message.meta` →
`GET /chat/messages/:id/verification` → badge in the UI. `cpuOnly` is real: `ollama ps`
showed the judge at **100% CPU** while the generator kept the card.

**It is off by default, and that is measured, not cautious.** Both candidate judges fail:

| Judge | Verdict on a correct Lao answer | Cost |
|---|---|---|
| `qwen3:8b` | **5/5 supported**, quoting the right source | 6.7 GB CPU-resident → swap exhausted → **kernel OOM-killed `llama-server` mid-answer** |
| `qwen2.5:3b-instruct` | **1/5 "not supported"** — on a corpus that plainly supports it | memory-safe |

```
oom-kill: task=llama-server, anon-rss:6545448kB
```

The CPU-only trick solves the 8 GB VRAM problem by moving the weights into a 15.4 GB system
RAM budget that SEA-LION (6.8 GB), bge-m3, Postgres, two sidecars and Next.js already share.
`keep_alive: 0s` was added so the judge unloads the instant it answers — after that fix,
memory settled at 5.5/15.4 GB with only the generator resident.

A badge that cries wolf on correct answers teaches people to ignore it on the answers that
matter. CLAUDE.md decision 4 wants ~20 human labels of calibration first, so the loop ships
built and disabled. `POST /chat/messages/:id/verify` checks one answer on demand.

## What this did not do

- **T0.2 restore drill** — untouched. `pre-wipe-20260810-145643.dump` (2.2 MB) is still the
  only likely copy of the real corpus.
- **T0.4 de-segmenting the eval questions** — the questions are still space-segmented, so
  recall is still measured against input no real user types.
- **T1.1/T1.2** — no faithfulness baseline, reranker still unbuilt (`"rerank": false`).
- **T2.2** — 610 glossary terms still unverified. This still has the best effort-to-impact
  ratio in the document, and bidirectional expansion just raised it further: every verified
  term now bridges the query in *both* directions.

---

# Addendum 2 — T0.4 measured, and what it actually found

## My T0.4 hypothesis was wrong. Say so plainly.

I flagged the space-segmented eval questions as a **blocking** finding that was inflating
recall, and predicted the number would drop once questions were de-segmented. It did not.

`EvalConfig.questionForm` (`as-stored` | `as-typed`, default `as-typed`) now runs the gold
question through `joinLaoWordSpaces` so LaoNLP segments the natural form — exactly what
happens to a question typed into `/chat`. Both arms, same 41 pairs, `hybrid-rrf`:

| Metric | `as-stored` | `as-typed` | Δ |
|---|---|---|---|
| recall@5 | 0.9268 | 0.9268 | **0** |
| nDCG@10 | 0.8088 | **0.8237** | +0.015 |
| MRR | 0.7699 | **0.7894** | +0.020 |
| precision@5 | 0.1854 | 0.1854 | 0 |

The segmentation was inflating nothing. Ranking is marginally *better* on the natural form —
bge-m3 does its own tokenization and prefers unsegmented text, and the dense arm carries this
corpus. `as-typed` stays the default because it is what a user produces, not because it
changed the score.

## What the misses actually are

Only three of 41 never retrieve their gold chunk. Reading them one at a time:

| Question | Verdict |
|---|---|
| "what does the annual financial report consist of?" | **Mislabeled gold.** The chunk that answers it (a table listing each report and what it shows) was retrieved at **rank 1**; the cited chunk is the balance-sheet equation, which is a different fact, and it was not in the top 10 at all. Scored as a total miss. |
| "at what rate is foreign currency converted to kip?" | **Genuine miss.** Gold is the rate table; the retriever returned the related prose ("accounts must be kept in kip") instead. |
| "can an advance from a customer be booked as revenue?" | The retriever's rank-1 chunk **answers the question** (a worked 5,000,000 kip deposit example). Gold points at a journal-entry table. |

So **recall@5 = 0.927 is a floor, not a ceiling** — it is bounded partly by label quality, not
retriever quality. At least one of the three "misses" is a correct answer scored zero.

> This is the more important half of the T0.3 split fix: the gold set is small enough that a
> single bad label moves recall by 2.4 points. Before tuning anything against these numbers,
> the 41 pairs are worth a re-read.

## The real finding: table chunks retrieve half as well as prose

Grouping every result by the *kind* of its gold chunk:

| gold kind | n | rank 1 | missed | avg rank |
|---|---|---|---|---|
| prose | 29 | **24 (83%)** | 1 | **1.21** |
| table | 12 | **5 (42%)** | 2 | **2.20** |

That one split explains the MRR of 0.79 almost entirely. Twelve table-gold questions averaging
rank 2.2 is what drags the mean down from the 1.21 prose achieves.

**Why:** `pipeline.ts:183` sets `contentNorm = fixLaoDefects(normalized(content))` — the
normalized content and nothing else. A table therefore embeds as raw pipe-delimited markdown:

```
| ບົດລາຍງານ | ສະແດງ ຫຍັງ | ໄລຍະ ເວລາ |
| --- | --- | --- |
| ໃບດຸ່ນດ່ຽງ | ຊັບສິນ ໜີ້ສິນ ແລະ ທຶນ | ...
```

with **no statement anywhere of what the table is about**. Its `heading_path`
(`["ບົດລາຍງານ ການເງິນ ປະຈຳ ປີ", …]`) is stored in its own column and never reaches either
retrieval input. Meanwhile `content_seg`'s tsvector is diluted by `|` and `---` structure
tokens that carry no meaning. And because CLAUDE.md makes tables **atomic** — correctly — they
are often long, which dilutes a single embedding further.

## Proposed fix (not yet built — it changes ingest and needs a re-embed)

Give a table the context a reader gets from the page:

1. **`content_norm` gains a context line** — document title + heading path, prepended before
   the table body. `content_norm` is *defined* as the dense-embedding input, so this is what
   the column is for; `content` stays byte-for-byte pristine, as CLAUDE.md requires.
2. **`content_seg` drops the structure tokens** (`|`, `---`) and gains the same heading terms,
   so the tsvector holds words instead of table scaffolding.
3. Re-embed: `bun run db:reembed` (100 chunks — minutes).
4. Re-run both arms and compare table rank-1 rate against the 42% baseline above.

Expected to move nDCG@10 and MRR rather than recall@5 — which is the right target, since
recall is already at the gate and ranking is not.

**This is a better use of effort than either the reranker or multi-query**, and it is cheaper
than both: no 2.5 GB download, no extra inference per query, no latency added to `/chat`. The
reranker remains worth measuring afterwards, on the same table-heavy questions.


---

# Addendum 3 — the tutor (phase L1: the spine)

Direction set 2026-08-26: turn the platform into a **step-by-step student tutor**, any
subject, lessons AI-drafted and human-verified, progress tracked per student.

Those three choices resolve each other. "Any subject" would normally mean losing
cite-or-abstain — the rule that stops a tutor teaching an invented tax rate. It does not
here, because lessons are drafted *from cited chunks*: the engine knows nothing about
accounting, while every lesson stays grounded in material this tenant actually ingested.
Accounting is simply the first subject because it is the corpus that exists.

## What shipped

**Six tables** (migration `0007`), each with `tenant_isolation` + `FORCE ROW LEVEL SECURITY`
**in the same migration that creates them** — a new tenant-scoped table without a policy
would quietly reopen the hole `0003` closed, and nothing in the type system would notice.
Verified: all six report `rls_on = t, forced = t, policies = 1`.

- `subject` — a learning area, pointing at the collections its lessons may cite
- `lesson` / `lesson_step` — ordered steps, each `intro | concept | example | check | recap`
- `student` — **deliberately password-less.** rag-api has no auth layer and binds loopback
  because of it; a password column would imply a guarantee the service does not make. This
  is a name picked on a shared device, and honest about being nothing more.
- `lesson_progress` — monotonic; re-reading step 2 of a lesson you finished is looking
  something up, not forgetting it
- `quiz_attempt` — **append-only.** The history *is* the signal: spaced repetition needs
  when a question was last seen and how it went, and a weak-topic view needs the pattern of
  misses, not the latest verdict.

**The visual spec** (`packages/contracts/src/learn.ts`) is what makes animation work for any
subject. A step carries no markup and no animation script — it carries a **visual type plus
typed data**, and the client owns the drawing. Eight general shapes: `balance`, `sequence`,
`flow`, `parts`, `compare`, `timeline`, `formula`, `table`. `balance` is the accounting
equation today and a chemistry equation tomorrow; `flow` is VAT through a sale, or a nitrogen
cycle. A drafting model can fill in data it read from a chunk; it cannot be trusted to emit
correct SVG, and un-reviewable markup in a database is markup nobody audits.

**The drafter** (`features/learn/draft.ts`) retrieves through the production retriever,
scoped to the subject's collections, and hands the model numbered sources. Two rules:

1. The model never sees a chunk id, so it cannot invent one — it cites by number and the
   numbers are mapped back. A step whose citations do not resolve is **dropped**.
2. **Check questions are not written by the model.** They come from `lao_qa_pair` where
   `verified = true` and the citations overlap the lesson's chunks. A human-verified,
   difficulty-graded question bank already exists; generating an unverified parallel one
   would be strictly worse and would need its own review queue.

**Practice** (`features/learn/practice.ts`) is spaced repetition as a query, not a subsystem
— `lao_qa_pair` and `quiz_attempt` already hold everything needed. Intervals key on
*consecutive* correct answers, found by counting back to the most recent wrong one: a plain
`COUNT(correct)` would call a question known that was missed four times and passed five,
which is exactly the question most needing to be asked again. Not SM-2, which wants a
self-rated recall score on every card — a second thing to ask on every question, and a known
source of noisy input.

**Separate student and curator routes**, not one route with an `includeDrafts` flag. A flag
defaulting the wrong way is how unreviewed material reaches a learner, and it fails silently
— the page renders either way. Fetching an unverified lesson as a student is a **404, not a
403**: a 403 leaks the existence of the review queue.

## Three bugs found by running it

1. **The citation CHECK constraint never fired.** `array_length('{}', 1)` is NULL, not 0 —
   and a CHECK *passes* when its expression is NULL. So `array_length(citation_ids,1) >= 1`
   permitted exactly the uncited step it was written to forbid. Fixed to `cardinality`
   (migration `0008`); caught by the test, not by review.
2. **A JS array interpolated into a raw `sql` template is emitted as a record**, and
   Postgres refuses to cast a record to `uuid[]`. Two queries; both now build the array with
   `sql.join`.
3. **The drafter had its own prompt and inherited none of the Lao orthography rules** the
   chat path spent so long getting right. First output: `ຂອງVATຢູ່ສປປ. ລາວແມ່ນ10%`. The rules
   are now a shared `LAO_WRITING_RULES` export, and `restoreInitialismSpacing`
   deterministically repairs `ສປປລາວ` — a closed list of bare-consonant runs Lao orthography
   cannot build words from, so inserting the space is safe for these entries and only these.

## Measured on the real corpus

Drafting "ອາກອນມູນຄ່າເພີ່ມ (VAT) ແມ່ນຫຍັງ ແລະ ຄິດໄລ່ແນວໃດ" produced an 8-step lesson:
`intro → concept → example → concept → 3 checks → recap`, 8 sources used, **0 steps dropped**,
3 check questions drawn from the verified bank.

Visuals needed a second pass. As a mid-prompt "a step MAY include a visual" it produced one in
eight; once the system prompt grew with the Lao rules, **zero**. Restated at the end as
"REQUIRED: at least TWO steps must include a visual" — the position `buildPrompt`'s own comment
says carries the most weight — it produced `flow` and `parts`. Same run: Lao spacing correct
(`ຫຼື VAT ແມ່ນອາກອນ`).

## Next: phase L2

Nothing student-facing exists yet — this is the spine, not the product.

- `/learn` — the step player: one step at a time, progress, "why?" opening the cited chunks,
  next/previous, completion
- **The eight visual renderers** — inline SVG/CSS, offline (the CSP admits no CDN),
  theme-aware, Phetsarath OT, `prefers-reduced-motion` respected
- `/studio/lessons` — the draft review queue: edit steps, fix a visual, approve
- Practice mode and the weak-topic view, both already served by the API


---

# Addendum 4 — the tutor (phase L2: the student surface)

L1 was the spine. This is the part a student uses. Driven end to end in a real browser, not
just typechecked.

## The eight visual renderers

`apps/web/src/features/learn/Visuals.tsx`, one exhaustive switch over the contract's
discriminated union — so adding a visual type without a renderer is a **compile error**
rather than a blank space in a lesson.

Every renderer honours four constraints:

- **Offline.** Inline SVG and CSS only. No charting library, no icon font.
- **Both themes.** Colour comes from `--chart-1..5` and the semantic tokens, never a
  literal — a hex tuned for the warm paper ground disappears on the dark one.
- **Lao renders as HTML text, never SVG `<text>`.** SVG text does not reflow, and a Lao
  label that overflows its box is unreadable rather than merely ugly.
- **Reduced motion.** Keyframes live in `globals.css` so there is one place to disable
  them, and the media query there is impossible to forget on a new visual. No
  `!important` needed — same specificity, later in the file.

Every animation is a **reveal, not a loop**: a lesson step is read once and read past, so
motion that continues after the eye arrives is noise competing with the text beside it.

## The student surface

- `/learn` — student picker (the roster is in Postgres; only *which* student is in
  localStorage, so clearing a browser loses a convenience, never progress), then subjects,
  lessons with progress bars, practice, and the weak-topics list.
- `/learn/[lessonId]` — **one step per screen**, which is the whole design. A lesson
  rendered as a long scroll is a document, and a student skims a document; a student who
  must press "next" has to decide each time that they understood the step they are on.
  Sticky progress, bottom-pinned navigation (the thumb is there, and a "next" that drifts
  down the page as steps lengthen is a moving target).
- **"Why?"** on any step opens the cited chunks inline, with their document titles.
- **Check steps are self-marked.** There is no reliable way to grade free-text Lao offline,
  and an auto-grader that marks a correct answer wrong teaches a student to distrust the
  tool. The schedule only needs to know whether they knew it.
- `/learn/practice` — the spaced-repetition queue, showing when each question returns.
  A visible schedule reads as progress; an invisible one reads as randomness.
- `/studio/lessons` — the review queue. Drafts sort first, each lesson expands inline with
  every step's **citation count** beside it, so a reviewer never leaves the page to check a
  claim.

Two API gaps L1 had left, both closed properly rather than faked: `GET /learn/citations`
(excludes rejected chunks, exactly as retrieval does) and `GET /learn/qa/:id/answer` —
which re-asserts `verified = true`, so a pair un-verified after a lesson was built stops
being shown as an answer instead of living on in a lesson copy.

## Driven in a browser

Created a student (ນ້ອຍ), opened the drafted VAT lesson, walked it, opened "why?", revealed
a check answer and marked it. The database afterwards:

```
student          ນ້ອຍ | lo
quiz_attempt     correct=t · elapsed 100664ms · from_lesson=t
lesson_progress  furthest_seq=4
```

The `flow` visual rendered its four nodes with animated arrows and edge labels; `parts`
rendered its segmented bar and legend. Lao composed correctly throughout.

**One bug found this way and fixed:** a step heading rendered `ຜູ້ຂຶ້ນທະບຽນVAT`. The
deterministic Lao repair was applied to `bodyLo` only — so the most prominent text on the
screen was the one line not being cleaned. Titles and summaries now go through the same
`repairLao` pass.

## Still open

- Step **editing** in the review queue — a curator can approve, unapprove or delete a
  lesson, but not fix a wrong sentence without re-drafting.
- The **"ask about this step"** hook into `/chat`, scoped to that step's citations.
- A **teacher view** across students; `quiz_attempt` already holds everything it needs.


---

# Addendum 5 — step editing in the review queue

The gap L2 left: a curator could approve, unapprove or delete a lesson, but not fix one
wrong sentence without re-drafting the whole thing.

## The rule that shapes it

**Every edit withdraws approval.** `updateQa` has done this for QA pairs since Phase 5, and
the reason carries over exactly: approval is a statement about specific text, so changing
the text withdraws it. Without the rule a curator could approve a lesson, then correct a tax
rate inside it, and the new number would reach students carrying an approval nobody gave it.

Proven end to end in the browser — edit a step on a `Live` lesson and:

```
before   verified=true
after    verified=false  verified_by=(null)
students 0 lesson(s) visible
UI       badge Live → Draft, button Unapprove → Approve
```

## What a curator can do

`PATCH /learn/curator/steps/:id` (kind, titles, bodies, visual, citations),
`POST /learn/curator/lessons/:id/steps`, `DELETE /learn/curator/steps/:id`,
`POST /learn/curator/steps/:id/move`, and `PATCH /learn/curator/lessons/:id` for metadata.

Three details worth recording:

- **Invariants are checked against the post-edit row**, not a mix of old and new that no
  version ever holds. Changing `kind` and `citationIds` in one request has to be judged as
  the row it produces.
- **Ordering respects the UNIQUE (lesson_id, seq) index.** Delete renumbers *ascending*,
  because each row moves into the slot the previous one just vacated — descending collides
  on the first move. A swap takes three writes, parking the step on `seq = -1` first.
- **The curator's own typing gets `repairLao` too.** Typed `ຢາກໃຈເຂົ້າໃຈVAT`, stored
  `ຢາກໃຈເຂົ້າໃຈ VAT`. The Lao rules are about what a student reads, not about who wrote it.

## Errors a curator can act on

An edit that breaks an invariant is a 422 carrying a sentence, and the client reads the
body rather than throwing the status — otherwise exactly the useful part is discarded.
Clearing the citations on a `concept` step shows:

> a "concept" step teaches a fact, so it must cite at least one source. Only "intro" and
> "recap" may go uncited.

The editor stays open with the values intact, so the fix is one field away. The database
CHECK constraints remain the final authority; this layer exists so a constraint *name* never
reaches a curator.

## The visual is edited as JSON

A builder for eight shapes is a lot of UI for a rare act. The drafter produces the visual;
a curator's realistic jobs are "fix a number in it" and "this picture is wrong, remove it" —
one textarea and a Remove button. The server validates against **the same zod schema the
renderer trusts**, so there is one authority on what is valid and a mistake comes back
naming the field.

## Tests

`features/learn/__tests__/edit.test.ts`, 10 cases, database-backed: approval withdrawn on
step and metadata edits, a concept step refusing to lose its citations, `intro` as the
documented escape hatch, a rejected chunk refused as evidence, an invalid visual refused
while `null` clears it, delete closing the seq gap, move swapping, moving past either end
being a no-op rather than an error, and a new step obeying the citation rule.

`bun run check`: 240 TS tests, 33 Python, lint and typecheck clean.


---

# Addendum 6 — chat tables that rendered as prose

Reported as "examine if data output similar table, make table for it". Examined the real
`rag_message` rows rather than reasoning about it, and the finding was narrower and more
concrete than the phrasing suggested.

## What was actually wrong

Markdown pipe-table rendering already existed and is thorough — ragged rows squared,
alignment inferred, numeric columns detected, citation prefixes handled, sticky header. The
failure was one character.

SEA-LION pads a divider row to the visual width of the column above it, then **abbreviates
its own padding**:

```
| ລະຫັດ | ຊື່ບັນຊີ | ເດບິດ (ກີບ) | ເຄຣດິດ (ກີບ) |
| :---------- | :--------------------------------------------- | :------… | :------… |
```

That `…` is U+2026, verified in the stored bytes (`M-bM-^@M-&`), not a display artefact.
`isTableDivider` matched the whole line against `[\s:|-]+`, which has no `…` in it — so the
divider failed, and a seventeen-row Lao journal-entry table rendered as a wall of
pipe-separated prose. **Two of the three account tables in the database were affected.**

## The fix

`isTableDivider` now judges **per cell** rather than by a character class over the line:

```
const DIVIDER_CELL = /^:?-+(?:…|\.{2,3})?:?$/;
```

Per-cell is both more forgiving of generator noise and **stricter about prose** —
`ບັນຊີ 411 | ລູກໜີ້ການຄ້າ` has cells full of Lao, and no tolerance inside a cell makes those
look like dashes. Empty cells are skipped so a ragged divider still counts; at least one
real divider cell is required, so `|  |  |` cannot open a table.

The cause is fixed too, since it is cheaper than the symptom: the system prompt now says a
divider contains only dashes and colons, never padded to column width and never abbreviated.

## Checked, not assumed

- Every pipe block in the real data **does** have a divider, so the divider-less case was
  not built for — it does not occur here.
- Five regression tests added, including the verbatim failing line from `rag_message`.
- Confirmed in the browser: the previously-broken answer now renders as
  "16 rows · 4 columns" with a sticky header.

## Left alone, deliberately — worth a decision

The generator emits `:---` on **every** column, including money. `tableAligns` honours
declared alignment over its own numeric inference, so kip amounts render left-aligned even
though the code would otherwise right-align them.

That rule ("explicit markdown alignment wins") is principled and was already there, so it
was not changed. But the model's `:---` is a default template rather than a considered
choice, and a column of kip that does not line up is harder to scan for an error — which in
accounting is the point of the column. Flagged for a decision rather than silently altered.


## Numeric alignment — the decision, taken

Approved: numeric columns right-align. Implemented as two rules rather than one, because
the naive version got it wrong on the first try and the tests caught it.

**Rule 1 — when is a declared alignment an instruction?** A divider that declares the SAME
alignment for every column says nothing about any particular one, and that is exactly what
the generator emits: `:---` everywhere, money included, as a template. A divider that
*varies*, or that marks only some columns, is a real decision and is honoured — a
hand-written table that deliberately left-aligns a column keeps it.

**Rule 2 — what is a quantity?** All-digits is not enough, and assuming it was is what the
tests caught: an account-code column (`613`, `531`, `37`) is entirely numeric, and
right-aligning variable-length labels leaves them ragged on the side the eye scans down.

The discriminator comes from this system's own money rule — *"All LAK amounts are integers,
thousands-separated, no decimals"*. So an amount always carries a separator somewhere, and a
column of bare integers is a code, a year or a count. Percentages and signed figures count
as quantities too.

```
ລະຫັດ    ຊື່ບັນຊີ                ເດບິດ (ກີບ)
613      ຄ່າເຊົ່າ                  4,000,000
531      ເງິນສົດໃນມື                       0
37       ສິນຄ້າຊື້ມາເພື່ອຂາຍ         9,000,000
4332     ອາກອນມູນຄ່າເພີ່ມຊື້ເຂົ້າ       900,000
```

**Tabular figures now follow the DATA, not the alignment.** They were previously withheld
from any column the divider had declared — which, given a `:---`-on-everything divider,
meant every money column in the application. A column of digits is easier to scan in
equal-width figures however it is aligned.

`resolveAligns` is exported and has 9 tests covering the generator's real divider shapes,
the account-code case, Lao-digit amounts, a bare-integer year column, and a mixed column
that is prose rather than figures. Confirmed in the browser on the real answers.


---

# Addendum 7 — teaching mode on /chat

Asked for: learning on `/chat`, with answers that read like a teacher teaching rather than
a colleague replying.

## A toggle, not a new default

`ສອນ / teach` sits beside the language picker, **off by default**. Always-on would turn
"what is the VAT rate?" into a six-section lesson — the right answer for a student and the
wrong one for an accountant checking a figure, and both share this box.

## What teaching mode changes

`TEACHING_RULES` replaces the terse persona with a shape: **short answer → terms → how it
works → worked example → common mistake → try it**. Define every term, show the step
*between* the numbers, work a real example through, name the mistake students actually
make, end with a question the model must not answer.

The tension the block has to hold: **a longer answer is where a model invents.** Every extra
sentence is another chance to round a rate to something neater or supply a plausible step
the sources never stated. So depth is bought from *explanation* — defining, showing working,
naming the pitfall — and buying it from invention is forbidden in as many words:

> Depth comes from EXPLAINING the sources, never from adding facts they do not contain.
> Where the sources do not cover something a student would need, say so plainly — an honest
> gap teaches better than a confident guess.

Cite-or-abstain is not relaxed here. It matters more: a student memorises what they are
taught.

## The window arithmetic

A teaching answer needs ~2,400 output tokens against 1,024. SEA-LION v3 caps at num_ctx
8192 and Ollama context-shifts the OLDEST tokens out on overflow — the system prompt first.
Raising the answer budget without lowering the context ceiling would evict **the teaching
rules themselves**, and the failure would look like "teach mode does nothing", with no error
anywhere. So `contextBudgetFor(teach)` drops the ceiling from 10,000 chars to 6,000.

Measured while writing the test, and worth recording because the first comment was wrong:
**neither ceiling binds at the default k=8.** `sourceCaps` caps each source at 700 chars, so
eight sources are 5,600 — under both, and a teaching answer already fits. The ceiling exists
for the top of the range, where `k=20` wants 14,000 chars.

`buildSystemPrompt` took an options object on the way past. It had six positional
parameters and the agent path called it `(terms, forbidden, false, false, false, lang)` —
three anonymous booleans. A seventh was where that stopped being tolerable.

## A bug found by testing it

The first teaching answer read `ຢູ່ສປປລາວ` — the initialism glued, the same defect fixed in
the lesson drafter and still live on the chat path. The joiner's restore only ran when the
text looked space-segmented, and the chat generator writes natural Lao: the register the
repair never reached.

Fixing it needed care, because restoring a space **inserts** text, and the joiner's whole
safety argument is that emitted text is never rewritten. `undecidedFrom` now holds back a
trailing partial initialism whether or not a space precedes it — emitting `ຢູ່ສປປ` and then
deciding the text reads `ຢູ່ ສປປ ລາວ` would rewrite a prefix already on the reader's screen.
Guarded by a test that asserts prefix stability across the whole stream.

## Verified live

```
sections   6/6   ຄຳຕອບສັ້ນ · ຄຳສັບ · ອະທິບາຍ · ຕົວຢ່າງ · ລະວັງ · ລອງເບິ່ງ
ສປປລາວ     absent      ສປປ ລາວ   present
example    9,000,000 + ອາກອນຊື້ເຂົ້າ 900,000 — worked through, real figures
try-it     asked, not answered
```

## Known limitation

**Citation density drops in teaching mode** — two to four `[n]` markers across a
1,400-character answer, where the rules ask for one per factual claim. The structure and the
figures are right; the model simply cites less when it writes more. The background verifier
(Addendum 1, currently off pending calibration) is the natural place to catch this, since it
already reads an answer against the chunks it cited.
