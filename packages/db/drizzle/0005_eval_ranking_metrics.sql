-- Ranking-quality metrics on eval_run.
--
-- recall@5 answers "did a supporting chunk reach the context window". It cannot answer
-- "was it at the top of it" — and a generator with a 5-chunk window fails on the second
-- while the first still reads 0.9. ndcg@10 is that missing number; hit_rate@5 is the
-- per-query binary a chat transcript actually shows you; precision@5 is the tripwire for
-- junk climbing into the window.
--
-- Nullable and NOT backfilled: historical runs did not measure these, and 0.0000 would
-- claim they did. The Studio renders NULL as "—" (see EvalClient).

ALTER TABLE "eval_run" ADD COLUMN "precision_at_5" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "eval_run" ADD COLUMN "ndcg_at_10" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "eval_run" ADD COLUMN "hit_rate_at_5" numeric(5, 4);