-- Fix the uncited-step CHECK, which never fired.
--
-- `array_length('{}'::uuid[], 1)` is NULL, not 0 — and a CHECK constraint PASSES when its
-- expression evaluates to NULL rather than failing. So the original
--   kind IN ('intro','recap') OR array_length(citation_ids, 1) >= 1
-- permitted precisely the uncited 'concept' step it was written to forbid. `cardinality`
-- returns 0 for an empty array, so the comparison is false and the row is refused.
--
-- A lesson step that asserts a fact must name the chunks the fact came from: it is what
-- makes a student's "why?" answerable and a reviewer's check possible.
ALTER TABLE "lesson_step" DROP CONSTRAINT IF EXISTS "lesson_step_citation_chk";--> statement-breakpoint
ALTER TABLE "lesson_step" ADD CONSTRAINT "lesson_step_citation_chk"
  CHECK ("kind" IN ('intro','recap') OR cardinality("citation_ids") >= 1);
