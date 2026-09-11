# Multi-model answering — implementation plan

_Status: **design valid, priority superseded.** Drafted 2026-08-26 against `feat/production-readiness`._

> **Read [`IMPROVEMENT-PLAN.md`](./IMPROVEMENT-PLAN.md) first.** Measurement against the live
> database showed recall@5 is already 0.927, so **Part B (multi-query) is demoted** — it is a
> recall lever aimed at a system without a recall problem. Part C is **promoted** and gains a
> repair loop. Parts A and D stand as designed. This document remains the detailed design; the
> ordering lives in the improvement plan.

One sentence: **the GPU becomes single-tenant and everything else moves to the CPU lane, which
is what makes "several models working on one question" possible on an 8 GB card at all.**

---

## 0. The constraint this plan is shaped by

| Resource | Reality |
|---|---|
| GPU | GTX 1080, **8192 MiB** |
| RAM / CPU | 15 GiB / 12 cores |
| `SEA-LION-v3-9B` Q4 (generator) | 5.8 GB + 8k-ctx KV → **effectively fills the card** |
| `qwen3:8b` (judge) | 5.2 GB |
| `qwen2.5:3b-instruct` | 1.9 GB |

`generate` and any 8B-class second model **cannot co-reside**. Loading one evicts the other, and
the reload costs 5–15 s on the next chat turn. So the naive "run three models in parallel" design
does not merely underperform here — it makes chat *slower* than it is today.

**The invariant that makes this work:**

> The GPU is held by the `generate` role and nothing else. Every other model role runs
> CPU-only (`options.num_gpu = 0`). The 12 cores are idle while the GPU generates.

A 3B Q4 on 12 cores does ~15–25 tok/s — ample for a 120-token query rewrite *concurrently with*
GPU generation. An 8B on CPU does ~4–6 tok/s — useless on the critical path, fine for a
background job whose result lands a minute after the answer.

---

## 1. Where the code is single-model today

| # | Site | Problem |
|---|---|---|
| 1 | `chat/service.ts:137` | `condenseQuery(p.message, history, p.model)` hands query rewriting to the **user-picked 9B generator**, on the critical path, before retrieval starts. The UI model picker silently re-targets the rewriter. |
| 2 | `lib/env.ts` `genModelAlt` | `qwen3:8b` is referenced only by `features/eval/judge.ts`. The cross-family verifier exists and never sees a real answer. |
| 3 | `search/service.ts:96` | Retrieval runs on **exactly one** query string. No variants, no decomposition, no HyDE — and GATE 6 is a *recall* gate. |
| 4 | `chat/service.ts` | The answer streams, is stored, and **nothing ever checks that its `[n]` citations support its claims.** |
| 5 | `lib/ollama.ts` | No model registry, no queue, no residency control. Called ad-hoc from ~6 sites. |

---

## 2. Part A — Foundation: model roles + an admission-controlled scheduler

### A1 · `services/rag-api/src/lib/models.ts` (new)

Callers ask for a **role**, never a model name:

```ts
export type ModelRole =
  | "generate"      // the answer                        — SEA-LION v3 9B      — GPU
  | "utility"       // condense, expand, route, classify — qwen2.5:3b-instruct — CPU
  | "verify"        // cross-family faithfulness check   — qwen3:8b            — CPU
  | "lao-correct"   // the /lao/check rewrite            — gemma-3n-laos       — CPU
  | "embed";        // bge-m3                                                  — GPU (tiny)
```

Each role resolves to `{ model, lane: "gpu" | "cpu", keepAlive, maxTokens }`, env-overridable:

| Env | Default | Status |
|---|---|---|
| `OLLAMA_GEN_MODEL` | `hf.co/aisingapore/Gemma-SEA-LION-v3-9B-IT-GGUF:latest` | exists |
| `OLLAMA_UTILITY_MODEL` | `qwen2.5:3b-instruct` | **new** |
| `OLLAMA_VERIFY_MODEL` | `qwen3:8b` (was `OLLAMA_GEN_MODEL_ALT`) | rename, alias kept |
| `OLLAMA_LAO_CORRECT_MODEL` | `gemma-3n-laos:Q4_K_M` | exists |
| `OLLAMA_CPU_LANE_CONCURRENCY` | `2` | **new** |

Why roles and not strings: it is the fix for problem #1. The user picks the *generator*; the
utility and verify roles are operator configuration and stop travelling with a UI dropdown.

### A2 · `services/rag-api/src/lib/scheduler.ts` (new)

An in-process two-lane semaphore + FIFO queue. **No broker** — consistent with Phase-0 decision 1.

- **GPU lane, concurrency 1.** `generate` and `embed`. Serialized, so ingest embedding never
  interleaves with a live answer and evicts it.
- **CPU lane, concurrency `OLLAMA_CPU_LANE_CONCURRENCY`.** Everything else, with
  `options.num_gpu = 0` injected. Bounded because Postgres and the two sidecars share the cores.
- `keep_alive` per role: `generate` keeps its 5-minute default (stay warm); CPU-lane roles pass
  `keep_alive: "30s"` so RAM is released between bursts.

`lib/ollama.ts` stays the transport. `scheduler.ts` is admission control, and every
`generate` / `generateStream` call routes through it.

### A3 · The one-line latency fix

`chat/service.ts:137` drops its `p.model` argument; `condenseQuery` takes the `utility` role.
Every multi-turn question stops paying 9B latency for a 120-token rewrite, and the rewrite now
runs on the CPU lane **concurrently with** the GPU work behind it.

---

## 3. Part B — Multi-model retrieval (the GATE 6 lever)

### B1 · `services/rag-api/src/features/search/expand.ts` (new)

The `utility` model turns one question into N retrieval queries (default 3), on the CPU lane:

1. **The condensed standalone question** — already produced by `condense.ts`.
2. **A terminology variant** — the question restated in verified glossary `termLo` forms. This is
   the highest-value variant for Lao specifically: users type colloquial forms, MoF documents use
   official ones, and the lexical arm currently misses on exactly that gap.
3. **An English-gloss variant** — see the rule check in §6; retrieval-only, never displayed,
   never stored.
4. *(off by default)* **HyDE** — a hypothetical answer paragraph, embedded rather than the question.

### B2 · Multi-query RRF fusion — `features/search/query.ts`

`hybridSearch` takes `queryEmbeddings: number[][]` and `querySegs: string[]` and emits one dense
CTE and one lexical CTE **per variant**, all fused by the same `1/(60 + rank)` sum already in the
SQL. This is the natural generalization of what is there: RRF is already the fusion operator, so
2N arms instead of 2 needs no new math and **no retuning of k=60** — which CLAUDE.md forbids
before the eval set exists, and which this change does not require.

Each hit carries the variant that found it, so the UI and the harness can see *why* a row is there.

Cost: N× HNSW probes inside the existing single transaction. Negligible at 292 chunks; **must be
re-measured against the 150 ms p95 budget at scale**, not assumed.

### B3 · It earns the chat path by winning a run, not by looking clever

Add `multi-query` and `multi-query+rerank` to the `Retriever` union in
`features/eval/retrievers.ts` and measure recall@5 / nDCG@10 against `hybrid-rrf` first.

This is Phase-0 decision 4's precedent applied to itself: the cross-encoder is parked off the chat
path until a run says it earns its latency, and a retrieval change gets the same treatment.
**Promotion to `/chat` happens after the numbers, not before.**

---

## 4. Part C — Background verification (the trust lever)

### C1 · Job kind `verify` on the existing job table

Reuse `ingest_job` with `kind = 'verify'`, `document_id NULL`, `payload = { messageId }`, drained
by the existing `SELECT ... FOR UPDATE SKIP LOCKED` worker, which already dispatches on `kind`.
No broker (decision 1); no new table.

*Naming caveat:* `ingest_job` is a generic job queue in everything but its name. Renaming it is a
migration that touches the worker, the schema, and two indexes — proposed as a separate, later
change rather than smuggled into this one.

The row is enqueued **in the same transaction as the assistant-message insert** — the outbox rule.

### C2 · `services/rag-api/src/features/chat/verify.ts` (new)

The background job:

1. Loads the stored assistant message and its `sources`.
2. Isolates the claims — the sentences carrying an `[n]`.
3. Calls **the existing `judgeFaithfulness()` from `features/eval/judge.ts`**, with the `verify`
   role on the CPU lane. The judge is already cross-family by construction: `qwen3` is not
   Gemma-based, which is what decision 4 requires.
4. Writes `{ verified: { score, supported, unsupportedClaims[], model, at } }` into
   `rag_message.meta` — the `jsonb` column already exists, so **no migration**.

Runtime ≈ 30–60 s on the CPU lane, entirely off the user's critical path.

### C3 · Contract and delivery

The SSE stream has already closed by the time a verdict exists, so a `verified` frame does **not**
belong in `streamEvent` — a frame that can never arrive on that stream is a lie in the contract.

Instead: a new `verificationResult` schema in `packages/contracts/src/chat.ts` and
`GET /chat/messages/:id/verification`, which `ChatClient` polls two or three times with backoff
after `done`. A per-conversation SSE channel is the upgrade if polling proves noisy; it is more
machinery than this earns on day one.

### C4 · What the user actually gets

A badge under each answer — verified ✓ / unsupported ⚠ — with the unsupported sentences marked.
That is the product value of multi-model, stated plainly: **a second model of a different family
quietly checks the first one's work and tells you when it is wrong.** And every ⚠ is a free
entry for the `/studio` gaps queue, which is the ROADMAP's flywheel.

**Calibration is a prerequisite, not a follow-up.** Decision 4 calls for ~20 human labels; a judge
that cries wolf is worse than no badge, so the badge ships dark until those labels exist.

---

## 5. Part D — Phase 2: multi-modal ingest (after A–C)

- New sidecar `services/vision-extractor` — Python 3.12 + FastAPI (CLAUDE.md), port **7733**.
- PDF → per-page render via `pypdfium2`; photographed invoices/receipts go in directly.
- **Tesseract with `lao` traineddata** as the deterministic, offline baseline.
- **`qwen2.5vl:7b` via Ollama** for table and layout structure — 7B vision cannot share the card
  with the generator, so it runs **ingest-time only, never on the chat path**, on the GPU lane the
  scheduler already serializes. This is precisely why Part A is built first.
- Output is the **same typed block stream `docx-extractor` already emits**, so
  `ingest/chunker.ts` is untouched.
- Every block carries `ocr_confidence`; the page image is stored under `storage/originals/` keyed
  by `content_sha256`, so `/studio/review` can show the crop beside the text.
- Chunks land `review='pending'` like everything else. **OCR proposes; a person disposes.**

---

## 6. Rule checks — decisions this plan needs from you

1. **English-gloss query variant vs "never machine-translate Lao".** My reading: the rule protects
   *stored content* ("English glosses are added alongside, never instead of"), and an EN query
   variant is a retrieval arm that is never displayed, never stored, and replaces nothing. But it
   is your rule and your call — say the word and B1.3 is dropped, leaving variants 1, 2 and 4.
2. **`ingest_job` reuse vs a rename migration** (§C1).
3. **Ordering:** Part B promotion is gated on an eval run that may say multi-query does not help.
   If it does not, B stays an eval arm and the chat path is unchanged — that is a real outcome of
   this plan, not a failure of it.

---

## 7. Gates

| Gate | Content | Done when |
|---|---|---|
| **M1** | `models.ts`, `scheduler.ts`, condense fix | `bun run check` green; turn-2 latency measurably down |
| **M2** | Multi-query as eval arms → measure → promote | A run shows recall@5 up vs `hybrid-rrf` |
| **M3** | Background verify + badge | Judge calibrated on ~20 human labels |
| **M4** | `vision-extractor` sidecar | A scanned PDF reaches `/studio/review` with crops |

## 8. Risks

- The whole design rests on **GPU single-tenant / everything-else-CPU**. Swap the generator for
  anything larger and the budget must be re-measured.
- Multi-query is N× dense scans; the 150 ms p95 budget at 200k chunks must be **measured**.
- An uncalibrated verifier is worse than none (§C4).
- Per CLAUDE.md, none of this substitutes for the actual GATE 6 blocker, which is **dataset
  volume** (`docs/ROADMAP.md` Phase 2). This plan raises the ceiling; it does not fill the factory.
