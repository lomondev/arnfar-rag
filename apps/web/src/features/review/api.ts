const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

export interface DocItem {
  id: string;
  title: string;
  collection: string;
  status: string;
  lang: string;
  chunks: number;
  pending: number;
}

export type ReviewState = "pending" | "accepted" | "edited" | "rejected";

export interface Chunk {
  id: string;
  seq: number;
  kind: "prose" | "table" | "account_row" | "list" | "journal_entry" | "formula";
  content: string;
  contentNorm: string;
  contentSeg: string;
  headingPath: string[];
  tokenCount: number;
  lang: string;
  review: ReviewState;
  embedded: boolean;
  meta: Record<string, unknown>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function fetchDocuments(): Promise<DocItem[]> {
  return fetch(`${BASE}/ingest/documents`).then((r) => json<DocItem[]>(r));
}

export function fetchChunks(docId: string): Promise<Chunk[]> {
  return fetch(`${BASE}/review/documents/${docId}/chunks`).then((r) => json<Chunk[]>(r));
}

export function patchChunk(
  id: string,
  body: { action: "accept" | "reject" | "edit"; content?: string },
): Promise<unknown> {
  return fetch(`${BASE}/review/chunks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json(r));
}

export function bulkAccept(
  documentId: string,
  opts: { kind?: string; minTokens?: number } = {},
): Promise<{ accepted: number }> {
  return fetch(`${BASE}/review/bulk-accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, ...opts }),
  }).then((r) => json<{ accepted: number }>(r));
}
