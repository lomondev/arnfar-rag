import { z } from "zod";

/**
 * Lao↔EN glossary terms.
 *
 * `verified` is false until a person clicks (CLAUDE.md): extraction proposes, a human
 * disposes, and only verified rows reach an export.
 */

export const term = z.object({
  id: z.string(),
  termLo: z.string(),
  termLoSeg: z.string(),
  termEn: z.string(),
  definitionLo: z.string().nullable(),
  definitionEn: z.string().nullable(),
  domain: z.string(),
  variantsLo: z.array(z.string()),
  forbiddenLo: z.array(z.string()),
  verified: z.boolean(),
});
export type Term = z.infer<typeof term>;

export const termInput = z.object({
  termLo: z.string().min(1),
  termEn: z.string().min(1),
  definitionLo: z.string().optional(),
  definitionEn: z.string().optional(),
  domain: z.string().optional(),
  variantsLo: z.array(z.string()).optional(),
  forbiddenLo: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
});
export type TermInput = z.infer<typeof termInput>;

export const glossaryMineRequest = z.object({
  minFreq: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  gloss: z.boolean().optional(),
});
export type GlossaryMineRequest = z.infer<typeof glossaryMineRequest>;
