import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { generateStream } from "../../lib/ollama.ts";
import { search } from "../search/service.ts";
import { buildContext, buildSystemPrompt, toSources, type CitationSource } from "./prompt.ts";

export interface ChatParams {
  message: string;
  collections?: string[];
  k?: number;
  model?: string;
  tenant: TenantContext;
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: "citations"; sources: CitationSource[]; glossaryMatches: unknown[] }
  | { type: "token"; t: string }
  | { type: "done" }
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

/** RAG chat: retrieve (hybrid + glossary expansion) → build the persona prompt →
 *  stream tokens. Emits a citations frame first so the UI can render [n] chips. */
export async function* chatStream(p: ChatParams): AsyncGenerator<ChatEvent> {
  try {
    const result = await search({
      query: p.message,
      collections: p.collections ?? [],
      k: p.k ?? 8,
      tenant: p.tenant,
    });
    const sources = toSources(result.hits);
    yield { type: "citations", sources, glossaryMatches: result.glossaryMatches };

    const { terms, forbidden } = await glossaryForPrompt(p.tenant);
    const system = buildSystemPrompt(terms, forbidden);
    const context = buildContext(sources);
    const prompt = `Context:\n${context}\n\nQuestion: ${p.message}\n\nAnswer (cite [n] or state it is not in the documents):`;

    const streamOpts = p.model
      ? { system, model: p.model, ...(p.signal ? { signal: p.signal } : {}) }
      : { system, ...(p.signal ? { signal: p.signal } : {}) };
    for await (const tok of generateStream(prompt, streamOpts)) {
      yield { type: "token", t: tok };
    }
    yield { type: "done" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
