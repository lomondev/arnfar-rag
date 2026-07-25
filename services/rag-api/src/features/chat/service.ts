import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { generateStream } from "../../lib/ollama.ts";
import { search } from "../search/service.ts";
import {
  CONTEXT_WINDOW,
  createConversation,
  insertMessage,
  recentMessages,
  titleFrom,
  trimForHistory,
} from "./conversation.ts";
import { buildSystemPrompt, buildPrompt, toSources, webToSources, type CitationSource } from "./prompt.ts";
import { webSearch as searchWeb } from "../websearch/service.ts";

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
  | { type: "citations"; sources: CitationSource[]; glossaryMatches: unknown[] }
  | { type: "token"; t: string }
  | { type: "done"; conversationId: string; assistantMessageId: string }
  | { type: "error"; error: string };

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
 *   3. Retrieve on the *current* question (hybrid + glossary expansion).
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

    // ── 3. Retrieve on the current question ────────────────────────────────────
    const result = await search({
      query: p.message,
      collections: p.collections ?? [],
      kinds: p.kinds ?? [],
      k: p.k ?? 8,
      tenant: p.tenant,
    });
    let sources = toSources(result.hits);
    if (p.webSearch) {
      // Fails soft: offline or blocked → [] and the answer stays dataset-only.
      const web = await searchWeb(p.message, 3);
      sources = [...sources, ...webToSources(web, sources.length)];
    }
    yield { type: "citations", sources, glossaryMatches: result.glossaryMatches };

    // ── 4. Build the prompt (history → context → question) and stream ───────────
    const { terms, forbidden } = await glossaryForPrompt(p.tenant);
    const system = buildSystemPrompt(terms, forbidden, sources.some((s) => s.origin === "web"));
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
      },
    });
    yield { type: "done", conversationId, assistantMessageId: assistantMsg.id };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
