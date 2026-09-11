import type { StreamEvent as ContractStreamEvent } from "@arnfar/contracts";
import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { env } from "../../lib/env.ts";
import { log } from "../../lib/logger.ts";
import { generateStream } from "../../lib/ollama.ts";
import { detectAndRunErpTools, erpToSources } from "../erp/service.ts";
import { createLaoJoiner, fixLaoTypography } from "../lao/clean.ts";
import {
  type AnswerLang,
  detectLanguage,
  type ResolvedAnswerLang,
  resolveAnswerLang,
} from "../lao/lang.ts";
import { search } from "../search/service.ts";
import { webSearch as searchWeb } from "../websearch/service.ts";
import { condenseQuery } from "./condense.ts";
import {
  CONTEXT_WINDOW,
  createConversation,
  insertMessage,
  noteConversationLang,
  recentMessages,
  titleFrom,
  trimForHistory,
} from "./conversation.ts";
import {
  ANSWER_TOKENS,
  buildPrompt,
  buildSystemPrompt,
  type CitationSource,
  toSources,
  webToSources,
} from "./prompt.ts";
import { applyGivenValues, extractGivenValues, type GivenValues } from "./values.ts";
import { enqueueVerification } from "./verify.ts";

export interface ChatParams {
  message: string;
  conversationId?: string;
  collections?: string[];
  /** Scope retrieval to knowledge kinds (the /chat picker's kind entries). */
  kinds?: string[];
  /** Opt-in internet augmentation: unverified web pages appended after dataset sources. */
  webSearch?: boolean;
  k?: number;
  model?: string;
  /** Values/attributes the user supplied for this question (chat/values.ts). */
  values?: GivenValues;
  /** Language to answer in. `auto` (the default) follows the question's script;
   *  `both` returns a full Lao answer and a full English one. */
  answerLang?: AnswerLang;
  /** Teach rather than answer: a structured explanation for a student, not a colleague. */
  teach?: boolean;
  tenant: TenantContext;
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: "created"; conversationId: string; userMessageId: string }
  | {
      type: "citations";
      sources: CitationSource[];
      glossaryMatches: unknown[];
      /** The question retrieval ran on — differs from the user's message when a
       *  follow-up was condensed into a standalone question. */
      retrievalQuery: string;
      /** Language the answer is being written in, already resolved. The UI labels the
       *  turn with it rather than re-sniffing the tokens as they arrive. */
      answerLang: ResolvedAnswerLang;
    }
  | { type: "token"; t: string }
  | { type: "done"; conversationId: string; assistantMessageId: string }
  | { type: "error"; error: string };

/**
 * The event union above and `streamEvent` in @arnfar/contracts describe the same wire
 * frames, and the browser decodes them with the contract. These two assignments fail to
 * compile the moment the shapes diverge — which is the check this boundary lacked when the
 * contract was first written against an imagined event list rather than this one.
 *
 * Bidirectional on purpose: one direction alone would let either side gain a field
 * silently.
 */
type _EventMatchesContract = ChatEvent extends ContractStreamEvent ? true : never;
type _ContractMatchesEvent = ContractStreamEvent extends ChatEvent ? true : never;
const _eventContractCheck: [_EventMatchesContract, _ContractMatchesEvent] = [true, true];
void _eventContractCheck;

async function glossaryForPrompt(tenant: TenantContext) {
  const rows = await db()
    .select({
      termLo: schema.laoTerm.termLo,
      termEn: schema.laoTerm.termEn,
      forbiddenLo: schema.laoTerm.forbiddenLo,
    })
    .from(schema.laoTerm)
    .where(
      and(
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
        eq(schema.laoTerm.verified, true),
      ),
    );
  const terms = rows.map((r) => ({ termLo: r.termLo, termEn: r.termEn }));
  const forbidden = rows.flatMap((r) => r.forbiddenLo);
  return { terms, forbidden };
}

/**
 * RAG chat with multi-turn memory. Flow:
 *   1. Resolve/create the conversation, persist the user turn.
 *   2. Load recent history (capped) for context injection.
 *   3. Condense history + question into a standalone query, retrieve on that
 *      (hybrid + glossary expansion).
 *   4. Stream tokens, accumulating the full answer.
 *   5. Persist the assistant turn (sources + meta) on completion.
 *
 * Emits a `created` frame first (server ids for the UI), then `citations`, then
 * `token` events, then `done`. If no conversationId is given a new conversation is
 * created from the first question — so single-turn callers keep working.
 */
export async function* chatStream(p: ChatParams): AsyncGenerator<ChatEvent> {
  try {
    // ── 1. Resolve / create conversation + persist the user turn ────────────────
    let conversationId = p.conversationId;
    if (!conversationId) {
      const conv = await createConversation(p.tenant, { title: titleFrom(p.message) });
      conversationId = conv.id;
    }
    // Resolve the answer language BEFORE anything else uses it: it shapes the system
    // prompt, the streaming joiner, and the language stamped on both stored turns.
    // Deterministic — script counts, not a model opinion (features/lao/lang.ts).
    const answerLang = resolveAnswerLang(p.answerLang ?? "auto", p.message);
    const questionLang = detectLanguage(p.message);

    const userMsg = await insertMessage(p.tenant, {
      conversationId,
      role: "user",
      content: p.message,
      meta: { lang: questionLang },
    });
    yield { type: "created", conversationId, userMessageId: userMsg.id };

    // ── 2. Load history for multi-turn context (excludes the turn just inserted) ──
    const historyRows = await recentMessages(p.tenant, conversationId, CONTEXT_WINDOW);
    // The last row is the user turn we just inserted — drop it from the history we
    // feed the model; the question is asked separately at the end of the prompt.
    const history = historyRows.slice(0, -1).map((m) => ({
      role: m.role,
      content: trimForHistory(m.role, m.content),
    }));

    // ── 3. Condense to a standalone question, then retrieve on it ──────────────
    // "ແລ້ວປີກາຍເດ?" carries its meaning in the history, not in its own words — embedding
    // it verbatim retrieves noise. Falls back to the raw message whenever the rewrite is
    // unavailable or fails a guard (see condense.ts).
    const condensed = await condenseQuery(p.message, history, p.model);
    const result = await search({
      query: condensed.query,
      collections: p.collections ?? [],
      kinds: p.kinds ?? [],
      k: p.k ?? 8,
      tenant: p.tenant,
    });
    let sources = toSources(result.hits);
    // ERP pre-pass — deterministic Lao intent patterns; read-only; fails soft. It reads the
    // user's LITERAL message, never the rewrite: these patterns lift account codes and
    // invoice numbers straight out of the text, and a paraphrase that shifted a digit would
    // query the wrong account. Retrieval is fuzzy and tolerates a rewrite; ERP lookups aren't.
    const erpCalls = await detectAndRunErpTools(p.message);
    if (erpCalls.length) sources = [...sources, ...erpToSources(erpCalls, sources.length)];
    if (p.webSearch) {
      // Fails soft: offline or blocked → [] and the answer stays dataset-only.
      const web = await searchWeb(condensed.query, 3);
      sources = [...sources, ...webToSources(web, sources.length)];
    }
    // Deterministic calculation over user-supplied values, appended last so its [n] is the
    // highest number and the retrieved corpus keeps its usual ordering.
    // Values come either from an explicit API caller or straight out of the question the
    // user typed — there is one input box, so the sentence is where they normally live.
    // Read from the LITERAL message, never `condensed.query`: the rewrite is for retrieval,
    // and a paraphrase that moved a digit would compute the wrong figure exactly.
    const suppliedValues = p.values ?? extractGivenValues(p.message);
    const given = suppliedValues
      ? applyGivenValues(suppliedValues, sources.length)
      : { sources: [], promptBlock: "", error: null };
    if (given.sources.length) sources = [...sources, ...given.sources];
    yield {
      type: "citations",
      sources,
      glossaryMatches: result.glossaryMatches,
      retrievalQuery: condensed.query,
      answerLang,
    };

    // ── 4. Build the prompt (history → context → question) and stream ───────────
    const teach = p.teach ?? false;
    const { terms, forbidden } = await glossaryForPrompt(p.tenant);
    const system = buildSystemPrompt({
      glossary: terms,
      forbidden,
      hasWeb: sources.some((s) => s.origin === "web"),
      hasErp: sources.some((s) => s.origin === "erp"),
      hasSuperseded: sources.some((s) => s.superseded !== null),
      answerLang,
      teach,
    });
    // The generator answers the user's ORIGINAL wording — only the retriever saw the
    // rewrite. Asking back a condensed question reads as if the assistant misheard.
    const prompt = buildPrompt(p.message, sources, history, given.promptBlock, answerLang, teach);

    const streamOpts = {
      system,
      // A teaching answer has six sections and a worked example; the default 1,024 tokens
      // truncates it mid-table, which reads worse than not teaching at all. The context
      // budget shrinks to match (contextBudgetFor) so the total still fits num_ctx —
      // otherwise Ollama evicts the head of the prompt, which is the teaching rules.
      maxTokens: teach ? ANSWER_TOKENS.teach : ANSWER_TOKENS.normal,
      ...(p.model ? { model: p.model } : {}),
      ...(p.signal ? { signal: p.signal } : {}),
    };

    // Lao is written without spaces between words; a space marks a phrase boundary. The
    // seeded corpus was authored space-segmented, and the generator copies the register of
    // its context — so answers came out reading as a token list. Repaired on the way to the
    // client AND into the stored message, so a reloaded conversation matches what was read
    // live. Deterministic, offline, and applied to generated text only (never `content`).
    // `en` answers contain no Lao to re-space, and holding them until six Lao runs
    // arrive would mean holding them forever — see NON_LAO_CHARS_FOR_VERDICT.
    const joiner = createLaoJoiner({ expectLao: answerLang !== "en" });
    let fullAnswer = "";
    for await (const tok of generateStream(prompt, streamOpts)) {
      const t = joiner.feed(tok);
      if (t === "") continue;
      fullAnswer += t;
      yield { type: "token", t };
    }
    const tail = joiner.flush();
    if (tail !== "") {
      fullAnswer += tail;
      yield { type: "token", t: tail };
    }
    // Typography is settled once, on the finished answer, and only the stored copy is
    // corrected: the rules are whole-text (trailing whitespace, blank-line runs) and
    // re-emitting a rewritten answer mid-stream would make the text jump under the reader.
    // The differences are whitespace-only, so the live and reloaded views agree on content.
    fullAnswer = fixLaoTypography(fullAnswer);

    // ── 5. Persist the assistant turn ───────────────────────────────────────────
    const assistantMsg = await insertMessage(p.tenant, {
      conversationId,
      role: "assistant",
      content: fullAnswer,
      sources,
      meta: {
        ...(p.model ? { model: p.model } : {}),
        ...(p.k ? { k: p.k } : {}),
        ...(p.collections ? { collections: p.collections } : {}),
        ...(p.webSearch ? { webSearch: true } : {}),
        ...(erpCalls.length ? { erpTools: erpCalls.map((c) => c.tool) } : {}),
        // Recorded only when it differs from the message — this is what a bad-recall
        // report needs to answer "what did it actually search for?".
        ...(condensed.rewritten ? { retrievalQuery: condensed.query } : {}),
        // Language the answer was written in, and whether the caller pinned it. The
        // mining pass (features/qa/mine.ts) reads these to route a turn to question_lo
        // or question_en without re-sniffing the text.
        answerLang,
        questionLang,
        ...(p.answerLang && p.answerLang !== "auto" ? { answerLangRequested: p.answerLang } : {}),
      },
    });

    // The conversation's own language stamp, kept current from the turns themselves.
    // `rag_conversation.lang` has been written at creation and read by nothing since; a
    // thread that starts in Lao and continues in English is `mixed`, and that is the
    // fact the sidebar and the mining pass both want.
    await noteConversationLang(p.tenant, conversationId, questionLang);

    // Queue the cross-family faithfulness check. Deliberately AFTER the answer is stored
    // and BEFORE `done`, so the verdict is already queued by the time the client starts
    // polling for it — but it never blocks the stream: the job runs on the CPU lane,
    // takes ~160 s (measured, qwen3:8b on 12 cores), and the reader already has their
    // answer long before then.
    //
    // Failure here must not fail a delivered answer. The turn is persisted; a missing
    // verdict shows as "unverified" in the UI, which is honest.
    if (env.verifyAnswers) {
      try {
        await enqueueVerification(p.tenant, assistantMsg.id);
      } catch (err) {
        log.warn("could not queue answer verification", {
          messageId: assistantMsg.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    yield { type: "done", conversationId, assistantMessageId: assistantMsg.id };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
