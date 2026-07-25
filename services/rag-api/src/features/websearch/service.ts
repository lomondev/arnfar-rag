/** Internet search — retrieval-side augmentation ONLY.
 *
 *  CLAUDE.md guard-rails, restated because they shape this file:
 *  - Generation stays on Ollama. This feature only FETCHES text; no cloud LLM call.
 *  - Offline-capable: everything here is opt-in per request (webSearch flag), fails
 *    soft (returns []), and nothing else depends on it.
 *  - Boundary: only rag-api touches the internet — the browser/RSC never do.
 *  - Web text is UNTRUSTED and UNVERIFIED: it is never written to the dataset, and
 *    web sources are labelled so the UI and the prompt treat them differently from
 *    dataset chunks. Promote-to-dataset filters them out (no chunk id to cite).
 *
 *  Providers: SearXNG when SEARXNG_URL is set (self-hosted metasearch — the better
 *  fit for this stack); DuckDuckGo's HTML endpoint otherwise (zero-config default).
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** Extracted page text (may be empty when the fetch failed — snippet still helps). */
  content: string;
}

/* ── providers ────────────────────────────────────────────────────────────── */

interface RawHit {
  title: string;
  url: string;
  snippet: string;
}

async function searxngSearch(base: string, query: string, k: number): Promise<RawHit[]> {
  const u = `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`searxng ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? [])
    .filter((r) => r.url)
    .slice(0, k)
    .map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: r.content ?? "" }));
}

const strip = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function ddgSearch(query: string, k: number): Promise<RawHit[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();

  // Each result: <a class="result__a" href="//duckduckgo.com/l/?uddg=<enc>&rut=…">title</a>
  // …<a class="result__snippet" …>snippet</a>. The real URL hides in the uddg param.
  const hits: RawHit[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(strip(sm[1] ?? ""));
  let m: RegExpExecArray | null;
  while (hits.length < k && (m = linkRe.exec(html)) !== null) {
    const raw = m[1] ?? "";
    const uddg = /[?&]uddg=([^&]+)/.exec(raw);
    const url = uddg ? decodeURIComponent(uddg[1] ?? "") : raw.startsWith("//") ? `https:${raw}` : raw;
    if (!/^https?:\/\//.test(url)) continue;
    hits.push({ title: strip(m[2] ?? "") || url, url, snippet: snippets[hits.length] ?? "" });
  }
  return hits;
}

/* ── page fetch + text extraction ─────────────────────────────────────────── */

const MAX_PAGE_BYTES = 500_000;
const MAX_EXTRACT_CHARS = 4_000;

async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(7000),
      redirect: "follow",
    });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("text/html")) return "";
    const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");
    return strip(body).slice(0, MAX_EXTRACT_CHARS);
  } catch {
    return ""; // fail soft — the search snippet still carries signal
  }
}

/* ── public API ───────────────────────────────────────────────────────────── */

/** Search the web and extract text from the top hits. Never throws: an offline box or
 *  a blocked engine yields [] and the caller proceeds dataset-only. */
export async function webSearch(query: string, k = 3): Promise<WebResult[]> {
  let hits: RawHit[];
  try {
    const searx = process.env.SEARXNG_URL;
    hits = searx ? await searxngSearch(searx, query, k) : await ddgSearch(query, k);
  } catch {
    return [];
  }
  return Promise.all(
    hits.map(async (h) => ({ ...h, content: await fetchPageText(h.url) })),
  );
}
