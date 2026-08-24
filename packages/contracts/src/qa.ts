import { z } from "zod";

/**
 * QA pairs — the dataset's headline asset.
 *
 * Two invariants are encoded here rather than only in the export query, so a malformed
 * pair is rejected at the boundary instead of being silently dropped at export time:
 * citations must be present, and the split is by source document (never by row).
 */

export const qaSplit = z.enum(["train", "test"]);
export type QaSplit = z.infer<typeof qaSplit>;

export const qaPair = z.object({
  id: z.string(),
  questionLo: z.string(),
  answerLo: z.string(),
  questionEn: z.string().nullable(),
  answerEn: z.string().nullable(),
  citationIds: z.array(z.string()),
  tags: z.array(z.string()),
  difficulty: z.number().int().min(1).max(5),
  source: z.string(),
  split: z.string(),
  verified: z.boolean(),
});
export type QaPair = z.infer<typeof qaPair>;

export const qaInput = z.object({
  questionLo: z.string().min(1),
  answerLo: z.string().min(1),
  questionEn: z.string().optional(),
  answerEn: z.string().optional(),
  // An uncited accounting claim is a liability (CLAUDE.md) — a verified pair with no
  // citations can never export, so refuse to create one rather than store a dead row.
  citationIds: z.array(z.string()),
  tags: z.array(z.string()).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  source: z.string().optional(),
  verified: z.boolean().optional(),
});
export type QaInput = z.infer<typeof qaInput>;
