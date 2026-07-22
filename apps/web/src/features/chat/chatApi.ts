/**
 * API client for server-backed conversations. Replaces the old localStorage
 * history: conversations and messages now live in Postgres (rag_conversation /
 * rag_message) and are fetched from rag-api.
 */

import type { Conversation, StoredSource } from "./storage";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

/** List-view summary of a conversation (no messages), with epoch-ms timestamps for the UI. */
export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly lang: string;
  readonly collection: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Raw API shape — timestamps are ISO strings. */
interface ApiConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly lang: string;
  readonly collection: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ApiConversationDetail {
  readonly id: string;
  readonly title: string;
  readonly lang: string;
  readonly collection: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly ApiMessage[];
}

interface ApiMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly sources: readonly StoredSource[] | null;
  readonly meta: Record<string, unknown>;
  readonly createdAt: string;
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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const rows = await getJson<readonly ApiConversationSummary[]>("/chat/conversations");
  return rows.map((r) => ({ ...r, createdAt: toEpoch(r.createdAt), updatedAt: toEpoch(r.updatedAt) }));
}

export async function getConversation(id: string): Promise<Conversation> {
  const detail = await getJson<ApiConversationDetail>(`/chat/conversations/${id}`);
  return toConversation(detail);
}

export async function createConversation(input: {
  title?: string;
  lang?: string;
  collection?: string;
}): Promise<ConversationSummary> {
  const row = await postJson<ApiConversationSummary>("/chat/conversations", input);
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
  await postJson("/chat/promote", input);
}

export async function reportWrong(chunkIds: readonly string[]): Promise<void> {
  await postJson("/chat/report-wrong", { chunkIds });
}
