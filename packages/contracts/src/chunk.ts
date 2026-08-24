import { z } from "zod";

import { lang } from "./tenant.ts";

/**
 * Chunks and retrieval hits — the shapes the review UI and the search surfaces read.
 *
 * `content` is the pristine original (CLAUDE.md): the API never sends a normalised
 * variant in its place, and the review UI edits `content` directly. `contentNorm` and
 * `contentSeg` travel alongside it so a reviewer can see what the embedder and the
 * lexical index actually received.
 */

export const reviewState = z.enum(["pending", "accepted", "edited", "rejected"]);
export type ReviewState = z.infer<typeof reviewState>;

export const chunkKind = z.enum([
  "prose",
  "table",
  "account_row",
  "list",
  "journal_entry",
  "formula",
]);
export type ChunkKind = z.infer<typeof chunkKind>;

export const chunk = z.object({
  id: z.string(),
  seq: z.number().int(),
  kind: chunkKind,
  content: z.string(),
  contentNorm: z.string(),
  contentSeg: z.string(),
  headingPath: z.array(z.string()),
  tokenCount: z.number().int(),
  lang: z.string(),
  review: reviewState,
  embedded: z.boolean(),
  meta: z.record(z.unknown()),
});
export type Chunk = z.infer<typeof chunk>;

/** PATCH /review/chunks/:id — accept, reject, or edit-and-requeue. */
export const chunkPatch = z
  .object({
    action: z.enum(["accept", "reject", "edit"]),
    content: z.string().optional(),
  })
  .refine((v) => v.action !== "edit" || (v.content?.trim().length ?? 0) > 0, {
    message: "edit requires non-empty content",
    path: ["content"],
  });
export type ChunkPatch = z.infer<typeof chunkPatch>;

/** A document row in the review/ingest list. */
export const docItem = z.object({
  id: z.string(),
  title: z.string(),
  collection: z.string(),
  status: z.string(),
  lang: z.string(),
  chunks: z.number().int(),
  pending: z.number().int(),
});
export type DocItem = z.infer<typeof docItem>;

/**
 * One retrieval hit. Snake_case because it is projected straight out of the hybrid SQL —
 * renaming it in the API would mean a second mapping layer for no gain, and the shape is
 * pinned here so the rename cannot happen accidentally on one side only.
 */
export const searchHit = z.object({
  id: z.string(),
  document_id: z.string(),
  content: z.string(),
  heading_path: z.array(z.string()),
  kind: z.string(),
  title: z.string(),
  score: z.number(),
  authority: z.string().nullable().optional(),
  effective_date: z.string().nullable().optional(),
  superseded_by_title: z.string().nullable().optional(),
  superseded_by_effective_date: z.string().nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type SearchHit = z.infer<typeof searchHit>;

export const documentLang = lang;
