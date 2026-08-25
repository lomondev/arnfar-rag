import { env } from "./env.ts";

/** Typed HTTP clients for the two Python sidecars. rag-api is the only caller. */

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// ── lao-nlp ──────────────────────────────────────────────────────────────────
export interface SegmentResult {
  tokens: string[];
  seg_text: string;
  token_count: number;
  lang: string;
}

export interface NormalizeResult {
  text: string;
  normalized: string;
  zero_width_removed: number;
  lang: string;
}

export interface SpellToken {
  token: string;
  is_lao: boolean;
  in_dictionary: boolean;
  suggestions: string[];
}

export interface SpellcheckResult {
  tokens: SpellToken[];
  unknown_count: number;
  lang: string;
}

export function segment(text: string): Promise<SegmentResult> {
  return postJson<SegmentResult>(`${env.laoNlpUrl}/segment`, { text });
}

export function normalize(text: string): Promise<NormalizeResult> {
  return postJson<NormalizeResult>(`${env.laoNlpUrl}/normalize`, { text });
}

export function spellcheck(text: string): Promise<SpellcheckResult> {
  return postJson<SpellcheckResult>(`${env.laoNlpUrl}/spellcheck`, { text });
}

export interface RerankHit {
  /** Index into the `documents` array that was sent — never the text back. */
  index: number;
  score: number;
}

export interface RerankResult {
  hits: RerankHit[];
  model: string;
}

/** Thrown when lao-nlp is running the default image, which has no cross-encoder.
 *  Distinguished from a real failure so a caller can fall back to the fused order
 *  instead of failing the query. */
export class RerankUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RerankUnavailableError";
  }
}

/** Cross-encoder rerank of `documents` against `query` (CLAUDE.md decision 4).
 *
 *  Deliberately not on the chat path yet: on CPU this costs seconds, not the <150ms the
 *  retrieval budget allows, so it is measured by the eval harness first and promoted only
 *  if a run says it earns the latency. */
export async function rerank(
  query: string,
  documents: string[],
  topK: number,
): Promise<RerankResult> {
  const res = await fetch(`${env.laoNlpUrl}/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, documents, top_k: topK }),
  });
  if (res.status === 503) {
    throw new RerankUnavailableError(await res.text());
  }
  if (!res.ok) throw new Error(`lao-nlp /rerank → ${res.status}: ${await res.text()}`);
  return (await res.json()) as RerankResult;
}

interface LaoNlpHealth {
  rerank?: boolean;
  rerank_model?: string | null;
}

/** Whether the running lao-nlp image has the cross-encoder built in. Returns false
 *  (never throws) when the sidecar is unreachable — the caller uses this to decide
 *  which retrievers to *offer*, and an offline sidecar should hide the arm, not 500. */
export async function rerankAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${env.laoNlpUrl}/health`);
    if (!res.ok) return false;
    return ((await res.json()) as LaoNlpHealth).rerank === true;
  } catch {
    return false;
  }
}

// ── docx-extractor ───────────────────────────────────────────────────────────
export interface ExtractBlock {
  type: "heading" | "prose" | "list" | "table" | "account_row";
  heading_path: string[];
  text?: string;
  level?: number;
  markdown?: string;
  cells?: string[][];
  amounts?: string[];
  // account_row
  code?: string;
  name_lo?: string;
  name_en?: string | null;
  confidence?: number;
}

export interface ExtractResult {
  blocks: ExtractBlock[];
  footnotes: string[];
  stats: {
    n_blocks: number;
    by_type: Record<string, number>;
    n_amounts: number;
    n_account_rows: number;
    heading_paths: string[][];
    footnotes: number;
  };
  warnings: string[];
}

export async function extractDocx(bytes: Uint8Array, filename: string): Promise<ExtractResult> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const res = await fetch(`${env.docxExtractorUrl}/extract`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`docx /extract → ${res.status}: ${await res.text()}`);
  return (await res.json()) as ExtractResult;
}
