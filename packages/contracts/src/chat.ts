import { z } from "zod";

/**
 * The /chat boundary: what the browser sends, what streams back, and how a conversation
 * is persisted.
 *
 * Every source a message cites is carried explicitly. `origin` distinguishes the three
 * kinds a citation can have, and the distinction is load-bearing rather than cosmetic:
 * "dataset" chunks are curated and exportable, "web" results are unverified, and "erp"
 * figures are point-in-time reads from the live company database that must never enter
 * the dataset.
 */

export const sourceOrigin = z.enum(["dataset", "web", "erp"]);
export type SourceOrigin = z.infer<typeof sourceOrigin>;

export const storedSource = z.object({
  n: z.number().int(),
  id: z.string(),
  content: z.string(),
  headingPath: z.array(z.string()),
  kind: z.string(),
  title: z.string(),
  authority: z.string().nullable(),
  effectiveDate: z.string().nullable(),
  origin: sourceOrigin.optional(),
  url: z.string().nullable().optional(),
});
export type StoredSource = z.infer<typeof storedSource>;

export const messageRole = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof messageRole>;

/** A persisted message as the API returns it — timestamps are ISO strings on the wire. */
export const apiMessage = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: messageRole,
  content: z.string(),
  sources: z.array(storedSource).nullable(),
  meta: z.record(z.unknown()),
  createdAt: z.string(),
});
export type ApiMessage = z.infer<typeof apiMessage>;

export const apiConversationSummary = z.object({
  id: z.string(),
  title: z.string(),
  lang: z.string(),
  collection: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApiConversationSummary = z.infer<typeof apiConversationSummary>;

export const apiConversationDetail = apiConversationSummary.extend({
  messages: z.array(apiMessage),
});
export type ApiConversationDetail = z.infer<typeof apiConversationDetail>;

/** POST /chat/stream. */
export const chatRequest = z.object({
  question: z.string().min(1),
  conversationId: z.string().optional(),
  k: z.number().int().min(1).max(20).optional(),
  scope: z.string().optional(),
  model: z.string().optional(),
  web: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof chatRequest>;

/**
 * Server-sent events on the answer stream.
 *
 * A discriminated union, so a client that handles `phase` but forgets `error` fails to
 * compile rather than silently ignoring a failed generation.
 */
export const streamPhase = z.enum(["searching", "reading", "writing"]);
export type StreamPhase = z.infer<typeof streamPhase>;

export const streamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: streamPhase, sources: z.number().int().optional() }),
  z.object({ type: z.literal("sources"), sources: z.array(storedSource) }),
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({ type: z.literal("conversation"), id: z.string(), title: z.string().optional() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type StreamEvent = z.infer<typeof streamEvent>;

export const promoteRequest = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  citationIds: z.array(z.string()).min(1),
});
export type PromoteRequest = z.infer<typeof promoteRequest>;
