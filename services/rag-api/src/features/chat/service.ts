import type { StreamEvent as ContractStreamEvent } from "@arnfar/contracts";
import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { generateStream } from "../../lib/ollama.ts";
import { detectAndRunErpTools, erpToSources } from "../erp/service.ts";
import { search } from "../search/service.ts";
import { webSearch as searchWeb } from "../websearch/service.ts";
import { condenseQuery } from "./condense.ts";
import {
  CONTEXT_WINDOW,
  createConversation,
  insertMessage,
  recentMessages,
  titleFrom,
  trimForHistory,
} from "./conversation.ts";
import {
  buildPrompt,
  buildSystemPrompt,
  type CitationSource,
  toSources,
  webToSources,
} from "./prompt.ts";

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
    const userMsg = await insertMessage(p.tenant, {
      conversationId,
      role: "user",
      content: p.message,
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
    yield {
      type: "citations",
      sources,
      glossaryMatches: result.glossaryMatches,
      retrievalQuery: condensed.query,
    };

    // ── 4. Build the prompt (history → context → question) and stream ───────────
    const { terms, forbidden } = await glossaryForPrompt(p.tenant);
    const system = buildSystemPrompt(
      terms,
      forbidden,
      sources.some((s) => s.origin === "web"),
      sources.some((s) => s.origin === "erp"),
      sources.some((s) => s.superseded !== null),
    );
    // The generator answers the user's ORIGINAL wording — only the retriever saw the
    // rewrite. Asking back a condensed question reads as if the assistant misheard.
    const prompt = buildPrompt(p.message, sources, history);

    const streamOpts = p.model
      ? { system, model: p.model, ...(p.signal ? { signal: p.signal } : {}) }
      : { system, ...(p.signal ? { signal: p.signal } : {}) };

    let fullAnswer = "";
    for await (const tok of generateStream(prompt, streamOpts)) {
      fullAnswer += tok;
      yield { type: "token", t: tok };
    }

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
      },
    });
    yield { type: "done", conversationId, assistantMessageId: assistantMsg.id };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
