import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { getDomain, type DomainConfig } from "../../domains/registry.ts";
import { getRole } from "../../domains/roles.ts";
import { db } from "../../lib/db.ts";
import { generate } from "../../lib/ollama.ts";
import { buildContext, buildSystemPrompt, toSources, type CitationSource } from "../chat/prompt.ts";
import { search } from "../search/service.ts";
import { coaSearch, glossaryLookup } from "../tools/service.ts";

/**
 * Agent orchestrator (ERP-RAG-VISION.md §A2A). One entry point routes a
 * question to a domain agent: resolve domain + role → deterministic tool
 * pre-pass → hybrid retrieval over the domain's collections → role-persona
 * generation under the shared cite-or-abstain rules.
 *
 * Phase 1 has a single active domain (accounting), so "routing" is a registry
 * lookup. When more domains activate, this is where the classifier/dispatcher
 * goes — callers of POST /agent/ask never change.
 *
 * Tool selection is deliberately deterministic (pattern-based), not LLM-driven:
 * the local generators are not reliable tool-callers, and a wrong silent tool
 * call in accounting is worse than none. The tool results are handed to the
 * generator as labeled context it must attribute.
 */

export interface AgentAsk {
  question: string;
  domain?: string;
  role?: string;
  k?: number;
  model?: string;
  tenant: TenantContext;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
}

export interface AgentAnswer {
  domain: string;
  role: string;
  answer: string;
  citations: CitationSource[];
  toolCalls: ToolCall[];
}

export class AgentError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Same verified-terminology injection the chat path uses. Kept local so the
 *  in-flight chat feature files stay untouched. */
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
  return {
    terms: rows.map((r) => ({ termLo: r.termLo, termEn: r.termEn })),
    forbidden: rows.flatMap((r) => r.forbiddenLo),
  };
}

/** Account codes are 4–6 digit tokens; take a few distinct ones from the question. */
function extractAccountCodes(question: string): string[] {
  const codes = question.match(/\b\d{4,6}\b/g) ?? [];
  return [...new Set(codes)].slice(0, 3);
}

async function runTools(
  domain: DomainConfig,
  tenant: TenantContext,
  question: string,
): Promise<ToolCall[]> {
  const calls: ToolCall[] = [];

  if (domain.tools.includes("coa_search")) {
    for (const code of extractAccountCodes(question)) {
      const result = await coaSearch(tenant, code, 5);
      if (result.length) calls.push({ tool: "coa_search", input: { q: code }, result });
    }
  }

  if (domain.tools.includes("glossary_lookup")) {
    const result = await glossaryLookup(tenant, question.slice(0, 60), 5);
    if (result.length) {
      calls.push({ tool: "glossary_lookup", input: { q: question.slice(0, 60) }, result });
    }
  }

  return calls;
}

function toolBlock(calls: ToolCall[]): string {
  if (!calls.length) return "";
  const lines = calls.map(
    (c) => `${c.tool}(${JSON.stringify(c.input)}):\n${JSON.stringify(c.result, null, 1)}`,
  );
  return `[Tool results — attribute claims from these as "(tool: <name>)"]\n${lines.join("\n\n")}`;
}

export async function askAgent(p: AgentAsk): Promise<AgentAnswer> {
  const domain = getDomain(p.domain);
  if (!domain) throw new AgentError(`unknown domain: ${p.domain}`, 404);
  if (domain.status !== "active") {
    throw new AgentError(`domain "${domain.key}" is planned but not active yet`, 409);
  }
  const role = getRole(p.role);
  if (!role) throw new AgentError(`unknown role: ${p.role}`, 404);
  if (!domain.roles.includes(role.key)) {
    throw new AgentError(`role "${role.key}" is not available in domain "${domain.key}"`, 422);
  }

  // Tool pre-pass and retrieval are independent — run them concurrently.
  const [toolCalls, retrieval, glossary] = await Promise.all([
    runTools(domain, p.tenant, p.question),
    search({
      query: p.question,
      collections: domain.collections,
      k: p.k ?? domain.retrieval.k,
      tenant: p.tenant,
    }),
    glossaryForPrompt(p.tenant),
  ]);
  const citations = toSources(retrieval.hits);

  const system = [
    buildSystemPrompt(glossary.terms, glossary.forbidden),
    domain.systemPreamble,
    role.persona,
  ]
    .filter(Boolean)
    .join("\n");

  const tools = toolBlock(toolCalls);
  const prompt = [
    `[Retrieved context]\n${buildContext(citations)}`,
    ...(tools ? [tools] : []),
    `Question: ${p.question}`,
    "Answer (cite [n], attribute tool results, or state the documents do not cover it):",
  ].join("\n\n");

  const answer = await generate(prompt, {
    system,
    temperature: 0.2,
    maxTokens: 800,
    ...(p.model ? { model: p.model } : {}),
  });

  return { domain: domain.key, role: role.key, answer, citations, toolCalls };
}
