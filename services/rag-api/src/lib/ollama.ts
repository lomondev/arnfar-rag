import { env } from "./env.ts";

/** Ollama client. Only rag-api talks to Ollama — never Next.js (CLAUDE.md).
 *  Embeddings use bge-m3 (1024-dim); the input is content_norm (natural Lao),
 *  never content_seg. */

const EMBED_BATCH = 32;
const MAX_RETRIES = 4;

interface EmbedResponse {
  embeddings?: number[][];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postWithRetry(path: string, body: unknown): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${env.ollamaBaseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      // Retry only on transient server errors.
      if (res.status < 500) {
        throw new Error(`ollama ${path} → ${res.status}: ${await res.text()}`);
      }
      lastErr = new Error(`ollama ${path} → ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_RETRIES) {
      const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await postWithRetry("/api/embed", { model: env.embedModel, input: texts });
  const data = (await res.json()) as EmbedResponse;
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error(
      `embed: expected ${texts.length} vectors, got ${data.embeddings?.length ?? 0}`,
    );
  }
  return data.embeddings;
}

/** Embed many texts, order-preserving, batched, with bounded concurrency so the
 *  ingest path never starves the shared chat path. */
export async function embedAll(texts: string[]): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    batches.push(texts.slice(i, i + EMBED_BATCH));
  }

  const results: number[][][] = new Array(batches.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= batches.length) return;
      results[idx] = await embedBatch(batches[idx]!);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(env.embedConcurrency, batches.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results.flat();
}

/** Embed a single query. */
export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec!;
}

interface GenerateResponse {
  response?: string;
}

interface TagsResponse {
  models?: { name?: string; model?: string }[];
}

/** Installed Ollama models that can generate text. The embed model (bge-m3) is excluded —
 *  it emits vectors, not text — so this can safely populate the /chat model picker.
 *  Returns [] if Ollama is unreachable; the caller falls back to the configured default. */
export async function listGenModels(): Promise<string[]> {
  const res = await fetch(`${env.ollamaBaseUrl}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags → ${res.status}`);
  const data = (await res.json()) as TagsResponse;
  const embedBase = env.embedModel.split(":")[0];
  return (data.models ?? [])
    .map((m) => m.name ?? m.model ?? "")
    .filter((n): n is string => n.length > 0)
    .filter((n) => (n.split(":")[0] ?? n) !== embedBase)
    .sort();
}

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  model?: string;
}

export interface StreamOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

/** Stream generation token-by-token (NDJSON from Ollama). Aborting the signal
 *  actually cancels the upstream Ollama request — not just the UI. */
export async function* generateStream(
  prompt: string,
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? env.genModel,
    prompt,
    stream: true,
    think: false,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_predict: opts.maxTokens ?? 800,
    },
  };
  if (opts.system) body.system = opts.system;

  const res = await fetch(`${env.ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`ollama /api/generate → ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const obj = JSON.parse(line) as { response?: string; done?: boolean };
      if (obj.response) yield obj.response;
      if (obj.done) return;
    }
  }
}

/** Non-streaming generation (qwen3:8b by default). `/no_think` + think:false keep
 *  qwen3 out of its slow reasoning mode for structured drafting. */
export async function generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? env.genModel,
    prompt: opts.json ? `${prompt}\n/no_think` : prompt,
    stream: false,
    think: false,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_predict: opts.maxTokens ?? 512,
    },
  };
  if (opts.system) body.system = opts.system;
  if (opts.json) body.format = "json";
  const res = await postWithRetry("/api/generate", body);
  const data = (await res.json()) as GenerateResponse;
  return (data.response ?? "").trim();
}
