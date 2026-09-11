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

/**
 * Where a citation came from, and therefore what it is worth.
 *
 * "calc" is a figure this system computed from values the USER supplied — exact, but true
 * only of those inputs, so like "erp" it is point-in-time and never exportable as dataset
 * knowledge. Keeping it a distinct origin is what lets the UI say so and the promote path
 * exclude it, rather than a computed number quietly becoming a cited accounting fact.
 */
export const sourceOrigin = z.enum(["dataset", "web", "erp", "calc"]);
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
  /**
   * Set when this source's document has been superseded; null when it is current.
   *
   * Not decoration — it is the difference between citing the VAT rate in force and citing
   * one that was repealed, so the citation panel has to be able to say so. This field was
   * missing from the first version of this schema, and the type assertion in
   * rag-api's chat service exists because of that.
   */
  superseded: z.object({ title: z.string(), effectiveDate: z.string().nullable() }).nullable(),
  origin: sourceOrigin,
  url: z.string().nullable(),
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

/**
 * POST /chat/stream.
 *
 * Field names match the route exactly — `message`, not `question`; `webSearch`, not `web`.
 * That sounds obvious and was wrong in the first draft of this file, which is precisely why
 * ChatClient now derives its request type from here instead of hand-writing a parallel one.
 */
/**
 * Values the user supplies alongside a question, so the system computes rather than guesses.
 *
 * `amountLak` is a STRING and `rateBp` is an integer in basis points, both deliberately: a
 * JSON number is a double, so a large kip amount would lose precision on the wire, and a
 * fractional percent would smuggle a float into money arithmetic. LAK is integer-only
 * (CLAUDE.md) and this is the boundary where that is easiest to break.
 */
export const givenValues = z.object({
  /** Digits, optionally thousands-separated as typed. */
  amountLak: z
    .string()
    .regex(/^[0-9][0-9,\s]*$/, "amount must be digits, optionally thousands-separated")
    .optional(),
  /** Basis points: 1000 = 10%. */
  rateBp: z.number().int().min(0).max(10000).optional(),
  mode: z.enum(["add", "extract"]).optional(),
  attributes: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .max(12)
    .optional(),
});
export type GivenValues = z.infer<typeof givenValues>;

/**
 * Language the caller wants the answer written in.
 *
 * `auto` follows the script of the question; `both` returns a complete Lao answer and a
 * complete English one in the same turn. Resolution is deterministic and happens server
 * side (rag-api `features/lao/lang.ts`) — the client states a preference, never a verdict.
 */
export const answerLang = z.enum(["auto", "lo", "en", "both"]);
export type AnswerLang = z.infer<typeof answerLang>;

/** What `auto` resolved to. Never `auto` — by the time this crosses the wire the
 *  question has been read and the language decided. */
export const resolvedAnswerLang = z.enum(["lo", "en", "both"]);
export type ResolvedAnswerLang = z.infer<typeof resolvedAnswerLang>;

/**
 * The cross-family verdict on a delivered answer.
 *
 * Deliberately NOT a `streamEvent` member: by the time a verdict exists the SSE stream has
 * closed, so a frame carrying it could never arrive there. The client polls
 * `GET /chat/messages/:id/verification` after `done`.
 */
export const verification = z.object({
  /** 1–5 from the judge; 0 when there was nothing to judge. */
  score: z.number().int().min(0).max(5),
  supported: z.boolean(),
  /** The answer said the sources do not cover the question — a correct abstention, not
   *  a failure, and the UI must not flag it as one. */
  abstained: z.boolean(),
  /** Thai characters in Lao output — always a defect, independent of the judge's view. */
  thaiContamination: z.boolean(),
  /** The answer carried no [n] marker at all. */
  uncited: z.boolean(),
  reason: z.string(),
  /** Which model judged. Recorded so a verdict stays interpretable after the judge is
   *  swapped — and so it is visible that it was not the generator judging itself. */
  model: z.string(),
  at: z.string(),
});
export type Verification = z.infer<typeof verification>;

/** `verification: null` means "queued, not yet judged" — not "passed". */
export const verificationResponse = z.object({
  messageId: z.string(),
  verification: verification.nullable(),
});
export type VerificationResponse = z.infer<typeof verificationResponse>;

export const chatRequest = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
  collections: z.array(z.string()).optional(),
  kinds: z.array(z.string()).optional(),
  webSearch: z.boolean().optional(),
  k: z.number().int().min(1).max(20).optional(),
  model: z.string().optional(),
  values: givenValues.optional(),
  answerLang: answerLang.optional(),
  /** Teach rather than answer: a structured explanation for a student. Longer, and the
   *  retrieval context shrinks to make room for it inside the model's window. */
  teach: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof chatRequest>;

/**
 * One SSE frame from the answer stream.
 *
 * A discriminated union, so a client that handles `token` but forgets `error` fails to
 * compile rather than silently swallowing a failed generation.
 *
 * The three-step progress indicator in the UI is NOT a server event — there is no "phase"
 * frame. The client derives searching → reading → writing from the order these arrive:
 * `created` means retrieval started, `citations` means sources are in hand, the first
 * `token` means generation began.
 */
export const streamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("created"),
    conversationId: z.string(),
    userMessageId: z.string(),
  }),
  z.object({
    type: z.literal("citations"),
    sources: z.array(storedSource),
    glossaryMatches: z.array(z.unknown()),
    /** The question retrieval ran on — differs from the user's message when a follow-up
     *  was condensed into a standalone question. */
    retrievalQuery: z.string(),
    /** Language the answer is being written in, already resolved server side. The UI
     *  labels the turn from this instead of sniffing tokens as they arrive. */
    answerLang: resolvedAnswerLang,
  }),
  z.object({ type: z.literal("token"), t: z.string() }),
  z.object({
    type: z.literal("done"),
    conversationId: z.string(),
    assistantMessageId: z.string(),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
export type StreamEvent = z.infer<typeof streamEvent>;

/**
 * POST /chat/promote — lift a good answer into the dataset.
 *
 * `citationIds` is min(1) here and `minItems: 1` on the route: an uncited pair could never
 * export anyway, so it is refused at the door rather than stored as a dead row.
 * `verify` is Teach mode, where the curator IS the reviewer.
 */
export const promoteRequest = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  citationIds: z.array(z.string()).min(1),
  tags: z.array(z.string()).optional(),
  verify: z.boolean().optional(),
  reviewer: z.string().min(1).max(100).optional(),
});
export type PromoteRequest = z.infer<typeof promoteRequest>;
