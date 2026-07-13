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
