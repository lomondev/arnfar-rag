/**
 * API client for server-backed conversations. Replaces the old localStorage
 * history: conversations and messages now live in Postgres (rag_conversation /
 * rag_message) and are fetched from rag-api.
 */

import {
  type ApiConversationDetail,
  apiConversationDetail,
  apiConversationSummary,
  parseResponse,
} from "@arnfar/contracts";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api";
import type { Conversation } from "./storage";

const BASE = apiBaseUrl();

/**
 * The wire shapes (ISO timestamps, nullable sources) live in @arnfar/contracts and are
 * parsed, not cast — a renamed field on the API side surfaces here as a named error
 * instead of a conversation list that silently renders "Invalid Date".
 */

/** List-view summary of a conversation (no messages), with epoch-ms timestamps for the UI. */
export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly lang: string;
  readonly collection: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const toEpoch = (iso: string): number => new Date(iso).getTime();

/** Convert the API detail response into the Conversation shape the UI expects. */
function toConversation(d: ApiConversationDetail): Conversation {
  return {
    id: d.id,
    title: d.title,
    createdAt: toEpoch(d.createdAt),
    updatedAt: toEpoch(d.updatedAt),
    messages: d.messages.map((m) => ({
      role: m.role,
      content: m.content,
      sources: m.sources ?? undefined,
    })),
  };
}

async function getParsed<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
  return parseResponse(schema, await res.json(), `GET ${path}`);
}

async function postParsed<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
  return parseResponse(schema, await res.json(), `POST ${path}`);
}

/** Fire-and-forget POST: the caller only needs to know it succeeded. */
async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const rows = await getParsed("/chat/conversations", z.array(apiConversationSummary));
  return rows.map((r) => ({
    ...r,
    createdAt: toEpoch(r.createdAt),
    updatedAt: toEpoch(r.updatedAt),
  }));
}

export async function getConversation(id: string): Promise<Conversation> {
  const detail = await getParsed(`/chat/conversations/${id}`, apiConversationDetail);
  return toConversation(detail);
}

export async function createConversation(input: {
  title?: string;
  lang?: string;
  collection?: string;
}): Promise<ConversationSummary> {
  const row = await postParsed("/chat/conversations", apiConversationSummary, input);
  return { ...row, createdAt: toEpoch(row.createdAt), updatedAt: toEpoch(row.updatedAt) };
}

export async function renameConversation(
  id: string,
  patch: { title?: string; lang?: string; collection?: string | null },
): Promise<void> {
  const res = await fetch(`${BASE}/chat/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`rag-api rename → ${res.status}`);
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/chat/conversations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`rag-api delete → ${res.status}`);
}

export async function promoteToDataset(input: {
  question: string;
  answer: string;
  citationIds: readonly string[];
  tags?: readonly string[];
  /** Teach mode: the curator is the reviewer — mark the QA pair verified immediately. */
  verify?: boolean;
  reviewer?: string;
}): Promise<void> {
  await post("/chat/promote", input);
}

export async function reportWrong(chunkIds: readonly string[]): Promise<void> {
  await post("/chat/report-wrong", { chunkIds });
}
