import {
  type Chunk,
  chunk,
  type DocItem,
  docItem,
  parseResponse,
  type ReviewState,
} from "@arnfar/contracts";
import { z } from "zod";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

/**
 * The review surface reads the pristine `content` column and writes edits back to it, so
 * a silent shape change here would corrupt what a reviewer thinks they are approving.
 * Responses are parsed against the shared contract rather than cast to it.
 */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function read<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  endpoint: string,
): Promise<z.infer<S>> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return parseResponse(schema, await res.json(), endpoint);
}

export function fetchDocuments(): Promise<DocItem[]> {
  return fetch(`${BASE}/ingest/documents`).then((r) =>
    read(r, z.array(docItem), "GET /ingest/documents"),
  );
}

export function fetchChunks(docId: string): Promise<Chunk[]> {
  return fetch(`${BASE}/review/documents/${docId}/chunks`).then((r) =>
    read(r, z.array(chunk), "GET /review/documents/:id/chunks"),
  );
}

export type { Chunk, DocItem, ReviewState };

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
