#!/usr/bin/env bun
/**
 * Loader for the accounting template files → your live rag-api.
 *
 *   bun run templates/accounting/load.ts
 *
 * Reads chart-of-accounts.csv, glossary.csv and qa.jsonl from this directory and
 * creates each row via the rag-api HTTP endpoints. There is no bulk importer in
 * rag-api, so this script is the bridge.
 *
 * Everything is created verified = false (accounts, terms) and unverified (QA):
 * extraction proposes, a human disposes. Verify in /studio/{accounts,glossary,qa}.
 *
 * QA citations: each qa.jsonl row carries a `citation_query` (natural Lao). Since
 * POST /qa requires at least one citation, this script resolves the query against
 * your real corpus via POST /search (top-1) and cites that chunk. It prints what it
 * resolved so you can verify the citation is actually correct. Provide explicit
 * `citation_ids` (real chunk UUIDs) to override the search.
 *
 * Knowledge docs (knowledge/*.md) are NOT loaded here — rag-api ingests .docx only
 * (POST /ingest/docx). Author in Markdown, save as .docx, upload via /studio/review.
 */

const API = process.env.RAG_API_URL ?? "http://localhost:7730";
const DIR = import.meta.dir;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── tiny RFC-4180-ish CSV parser (quoted fields, embedded commas, "" escapes) ──
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const arr = (s: string | undefined): string[] =>
  s ? s.split("|").map((x) => x.trim()).filter(Boolean) : [];

interface PostResult { status: number; json: Record<string, unknown> | null; }
async function jpost(path: string, body: unknown): Promise<PostResult> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* no body */ }
  return { status: res.status, json };
}
const errmsg = (j: Record<string, unknown> | null): string =>
  j && typeof j.error === "string" ? j.error : "";

async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/health`);
    return res.ok;
  } catch { return false; }
}

// ── accounts ──────────────────────────────────────────────────────────────────
async function loadAccounts(): Promise<void> {
  const rows = parseCsv(await Bun.file(`${DIR}/chart-of-accounts.csv`).text());
  let created = 0, skipped = 0, failed = 0;
  for (const a of rows) {
    const body = {
      code: a.code,
      nameLo: a.name_lo,
      ...(a.name_en ? { nameEn: a.name_en } : {}),
      ...(a.parent_code ? { parentCode: a.parent_code } : {}),
      accountClass: a.class,
      normalBalance: a.normal_balance,
      statement: a.statement,
    };
    const { status, json } = await jpost("/accounts/", body);
    if (status === 201) created++;
    else if (status === 409) skipped++;
    else { failed++; console.log(`  ✗ account ${a.code}: ${status} ${errmsg(json)}`); }
  }
  console.log(`accounts:  ${created} created, ${skipped} already existed, ${failed} failed  (${rows.length} rows)`);
}

// ── glossary ──────────────────────────────────────────────────────────────────
async function loadGlossary(): Promise<void> {
  const rows = parseCsv(await Bun.file(`${DIR}/glossary.csv`).text());
  let created = 0, skipped = 0, failed = 0;
  for (const t of rows) {
    const body = {
      termLo: t.term_lo,
      termEn: t.term_en,
      ...(t.definition_lo ? { definitionLo: t.definition_lo } : {}),
      ...(t.definition_en ? { definitionEn: t.definition_en } : {}),
      variantsLo: arr(t.variants_lo),
      forbiddenLo: arr(t.forbidden_lo),
      domain: "accounting",
    };
    const { status, json } = await jpost("/glossary/", body);
    if (status === 201) created++;
    else if (status === 409) skipped++;
    else { failed++; console.log(`  ✗ term ${t.term_lo}: ${status} ${errmsg(json)}`); }
  }
  console.log(`glossary:  ${created} created, ${skipped} already existed, ${failed} failed  (${rows.length} rows)`);
}

// ── qa ────────────────────────────────────────────────────────────────────────
interface QaTemplate {
  question_lo: string;
  answer_lo: string;
  citation_query?: string;
  citation_ids?: string[];
  tags?: string[];
  difficulty?: number;
  source?: "human" | "chat_promoted";
}
async function loadQa(): Promise<void> {
  const lines = (await Bun.file(`${DIR}/qa.jsonl`).text())
    .split("\n").map((l) => l.trim()).filter(Boolean);
  let created = 0, failed = 0, unresolved = 0;
  for (const line of lines) {
    const q = JSON.parse(line) as QaTemplate;
    let citationIds = (q.citation_ids ?? []).filter((id) => UUID.test(id));

    if (citationIds.length === 0 && q.citation_query) {
      // Search at k=8 (the domain default), NOT k=1. Hybrid search fuses dense + lexical
      // with RRF over each arm's top-k candidate pool; a tiny k starves the fusion and the
      // top-1 becomes unreliable (a spurious dense match can win). We still cite hits[0],
      // but from a healthy pool. The printed snippet is there for you to eyeball.
      const { json } = await jpost("/search/", { query: q.citation_query, k: 8 });
      const hits = (json?.hits as { id: string; content?: string }[] | undefined) ?? [];
      if (hits[0]?.id) {
        citationIds = [hits[0].id];
        const snip = (hits[0].content ?? "").replace(/\s+/g, " ").slice(0, 60);
        console.log(`  → "${q.citation_query}"\n      cites ${hits[0].id}: ${snip}…  (verify!)`);
      }
    }
    if (citationIds.length === 0) {
      unresolved++;
      console.log(`  ⚠ no citation resolved, skipped: ${q.question_lo}`);
      continue;
    }

    const body = {
      questionLo: q.question_lo,
      answerLo: q.answer_lo,
      citationIds,
      ...(q.tags ? { tags: q.tags } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty } : {}),
      ...(q.source ? { source: q.source } : {}),
    };
    const { status, json } = await jpost("/qa/", body);
    if (status === 200 || status === 201) created++;
    else { failed++; console.log(`  ✗ qa "${q.question_lo}": ${status} ${errmsg(json)}`); }
  }
  console.log(`qa:        ${created} created, ${unresolved} unresolved, ${failed} failed  (${lines.length} rows)`);
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`Loading accounting templates → ${API}\n`);
if (!(await health())) {
  console.error(`rag-api not reachable at ${API}. Start it (bun run start) or set RAG_API_URL.`);
  process.exit(1);
}
await loadAccounts();
await loadGlossary();
await loadQa();
console.log(`\nDone. Everything is unverified — review and accept in /studio/accounts, /studio/glossary, /studio/qa.`);
console.log(`Then: POST /qa/assign-splits assigns train/dev/test by document before export.`);
