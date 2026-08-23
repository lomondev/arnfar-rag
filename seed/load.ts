#!/usr/bin/env bun
/**
 * Seed loader — fills a running stack with a realistic Lao accounting corpus so the
 * whole pipeline (ingest → chunk → segment → embed → hybrid search → chat → QA →
 * export) can be exercised end to end without any real client documents.
 *
 *   bun run seed/load.ts
 *
 * What it loads, in dependency order:
 *   1. knowledge/*.md  → POST /ingest/docx   (rag_document + rag_chunk, then embed)
 *   2. chart-of-accounts.csv → POST /accounts/
 *   3. glossary.csv    → POST /glossary/
 *   4. qa.jsonl        → POST /qa/           (citations resolved against step 1)
 *
 * Knowledge is ingested FIRST and its embed jobs are awaited, because every QA row
 * cites a chunk found by searching the corpus — searching before the embeddings land
 * returns lexical-only hits and the citations come out worse.
 *
 * Re-running is safe: documents dedupe on content sha256, accounts and terms return
 * 409 and are skipped. QA pairs have no natural key and WOULD duplicate, so QA is
 * skipped automatically when the tenant already holds seeded pairs (--force-qa to
 * override).
 *
 * Everything lands unverified — extraction proposes, a human disposes. Pass --verify
 * to auto-accept accounts, terms and QA when you need a verified state to test export.
 *
 * Flags: --skip-knowledge --skip-accounts --skip-glossary --skip-qa
 *        --no-wait (do not wait for embeddings) --verify --force-qa
 *        --assign-splits (run POST /qa/assign-splits at the end)
 *
 * Set RAG_API_URL if rag-api is not on http://localhost:7730.
 */

const API = process.env.RAG_API_URL ?? "http://localhost:7730";
const DIR = import.meta.dir;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stamped on every seeded document so a citation says out loud that it is test data
 *  and not a real Ministry source. Do not remove — an unmarked fake authority in an
 *  accounting corpus is exactly the liability CLAUDE.md warns about. */
const SEED_AUTHORITY = "ຂໍ້ມູນຕົວຢ່າງ SEED — ບໍ່ແມ່ນເອກະສານທາງການ";
const SEED_EFFECTIVE_DATE = "2026-01-01";
const SEED_LICENSE = "internal";

const flags = new Set(process.argv.slice(2));
const has = (f: string): boolean => flags.has(f);

// ── http helpers ──────────────────────────────────────────────────────────────
interface Res {
  status: number;
  json: Record<string, unknown> | null;
}

async function req(path: string, init: RequestInit): Promise<Res> {
  const res = await fetch(`${API}${path}`, init);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

const jpost = (path: string, body: unknown): Promise<Res> =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const jpatch = (path: string, body: unknown): Promise<Res> =>
  req(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errmsg = (j: Record<string, unknown> | null): string =>
  j && typeof j.error === "string" ? j.error : "";

const str = (j: Record<string, unknown> | null, key: string): string | null => {
  const v = j?.[key];
  return typeof v === "string" ? v : null;
};

const num = (j: Record<string, unknown> | null, key: string): number =>
  typeof j?.[key] === "number" ? (j[key] as number) : 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── CSV (RFC-4180-ish: quoted fields, embedded commas, "" escapes) ────────────
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const arr = (s: string | undefined): string[] =>
  s ? s.split("|").map((x) => x.trim()).filter(Boolean) : [];

// ── 1. knowledge documents ────────────────────────────────────────────────────
interface KnowledgeEntry {
  file: string;
  collection: string;
  title: string;
}

/** Poll the embed job until it leaves queued/running. Returns embedded/total. */
async function waitForEmbed(jobId: string, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { status, json } = await req(`/ingest/jobs/${jobId}`, { method: "GET" });
    if (status !== 200 || !json) return;
    const state = str(json, "status");
    if (state === "done") {
      console.log(`      embedded ${num(json, "embedded")}/${num(json, "total")} chunks`);
      return;
    }
    if (state === "failed") {
      console.log(`      ✗ embed job failed: ${str(json, "lastError") ?? "unknown error"}`);
      return;
    }
    await sleep(1000);
  }
  console.log(`      ⚠ ${label}: embed job still running after 300s — continuing`);
}

async function loadKnowledge(): Promise<void> {
  const entries = JSON.parse(
    await Bun.file(`${DIR}/knowledge/index.json`).text(),
  ) as KnowledgeEntry[];

  let ingested = 0;
  let deduped = 0;
  let failed = 0;
  const jobs: { id: string; label: string }[] = [];

  for (const e of entries) {
    const file = Bun.file(`${DIR}/knowledge/${e.file}`);
    const form = new FormData();
    // Third arg sets the multipart filename — rag-api dispatches extraction on the
    // extension (.md parses in-process), so it has to be the real name, not a path.
    form.append("file", file, e.file);
    form.append("collection", e.collection);
    form.append("title", e.title);
    form.append("authority", SEED_AUTHORITY);
    form.append("effectiveDate", SEED_EFFECTIVE_DATE);
    form.append("license", SEED_LICENSE);

    const { status, json } = await req("/ingest/docx", { method: "POST", body: form });
    if (status !== 200 || !json) {
      failed++;
      console.log(`  ✗ ${e.file}: ${status} ${errmsg(json)}`);
      continue;
    }
    if (json.deduped === true) {
      deduped++;
      console.log(`  = ${e.file} — already ingested (same sha256), skipped`);
      continue;
    }
    ingested++;
    console.log(
      `  + ${e.file} → ${e.collection}: ${num(json, "chunkCount")} chunks, ${num(json, "accountRows")} account rows`,
    );
    const warnings = Array.isArray(json.warnings) ? (json.warnings as unknown[]) : [];
    for (const w of warnings) console.log(`      ⚠ ${String(w)}`);
    const jobId = str(json, "jobId");
    if (jobId) jobs.push({ id: jobId, label: e.file });
  }

  console.log(
    `knowledge: ${ingested} ingested, ${deduped} already present, ${failed} failed  (${entries.length} files)`,
  );

  if (has("--no-wait")) {
    console.log("  (--no-wait: not waiting for embeddings — QA citations will be lexical-only)");
    return;
  }
  for (const j of jobs) {
    console.log(`  … embedding ${j.label}`);
    await waitForEmbed(j.id, j.label);
  }
}

// ── 2. chart of accounts ──────────────────────────────────────────────────────
async function loadAccounts(): Promise<void> {
  const rows = parseCsv(await Bun.file(`${DIR}/chart-of-accounts.csv`).text());
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const ids: string[] = [];

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
    if (status === 201) {
      created++;
      const id = str(json, "id");
      if (id) ids.push(id);
    } else if (status === 409) skipped++;
    else {
      failed++;
      console.log(`  ✗ account ${a.code}: ${status} ${errmsg(json)}`);
    }
  }
  console.log(
    `accounts:  ${created} created, ${skipped} already existed, ${failed} failed  (${rows.length} rows)`,
  );

  if (has("--verify") && ids.length > 0) {
    let ok = 0;
    for (const id of ids) {
      const { status } = await jpatch(`/accounts/${id}/verify`, {});
      if (status === 200) ok++;
    }
    console.log(`           ${ok}/${ids.length} verified (--verify)`);
  }
}

// ── 3. glossary ───────────────────────────────────────────────────────────────
async function loadGlossary(): Promise<void> {
  const rows = parseCsv(await Bun.file(`${DIR}/glossary.csv`).text());
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const ids: string[] = [];

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
    if (status === 201) {
      created++;
      const id = str(json, "id");
      if (id) ids.push(id);
    } else if (status === 409) skipped++;
    else {
      failed++;
      console.log(`  ✗ term ${t.term_lo}: ${status} ${errmsg(json)}`);
    }
  }
  console.log(
    `glossary:  ${created} created, ${skipped} already existed, ${failed} failed  (${rows.length} rows)`,
  );

  if (has("--verify") && ids.length > 0) {
    let ok = 0;
    for (const id of ids) {
      const { status } = await jpatch(`/glossary/${id}/verify`, { reviewer: "seed" });
      if (status === 200) ok++;
    }
    console.log(`           ${ok}/${ids.length} verified (--verify)`);
  }
}

// ── 4. QA pairs ───────────────────────────────────────────────────────────────
interface QaRow {
  question_lo: string;
  answer_lo: string;
  citation_query?: string;
  citation_ids?: string[];
  tags?: string[];
  difficulty?: number;
  source?: "human" | "chat_promoted";
}

/** QA pairs have no natural key, so a second run would duplicate all of them.
 *  GET /qa/stats answers with an ARRAY of {verified, split, source, n} groups — sum
 *  the counts rather than reading a total field that does not exist. */
async function qaAlreadySeeded(): Promise<boolean> {
  const res = await fetch(`${API}/qa/stats`).catch(() => null);
  if (!res?.ok) return false;
  const stats = (await res.json().catch(() => null)) as { n?: number }[] | null;
  if (!Array.isArray(stats)) return false;
  return stats.reduce((sum, g) => sum + (typeof g.n === "number" ? g.n : 0), 0) > 0;
}

async function loadQa(): Promise<void> {
  if (!has("--force-qa") && (await qaAlreadySeeded())) {
    console.log("qa:        skipped — tenant already has QA pairs (--force-qa to load anyway)");
    return;
  }

  const lines = (await Bun.file(`${DIR}/qa.jsonl`).text())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let created = 0;
  let unresolved = 0;
  let failed = 0;
  const ids: string[] = [];

  for (const line of lines) {
    const q = JSON.parse(line) as QaRow;
    let citationIds = (q.citation_ids ?? []).filter((id) => UUID.test(id));

    if (citationIds.length === 0 && q.citation_query) {
      // k=8 is the domain default. RRF fuses dense + lexical over each arm's candidate
      // pool, so a tiny k starves the fusion and top-1 becomes unreliable. Cite hits[0]
      // out of a healthy pool, and print the snippet so a human can eyeball it.
      const { json } = await jpost("/search/", { query: q.citation_query, k: 8 });
      const hits = (json?.hits as { id: string; content?: string }[] | undefined) ?? [];
      const top = hits[0];
      if (top?.id) {
        citationIds = [top.id];
        const snip = (top.content ?? "").replace(/\s+/g, " ").slice(0, 56);
        console.log(`  → ${top.id.slice(0, 8)}… ${snip}…`);
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
    if (status === 200 || status === 201) {
      created++;
      const id = str(json, "id");
      if (id) ids.push(id);
    } else {
      failed++;
      console.log(`  ✗ qa "${q.question_lo}": ${status} ${errmsg(json)}`);
    }
  }
  console.log(
    `qa:        ${created} created, ${unresolved} unresolved, ${failed} failed  (${lines.length} rows)`,
  );
  console.log("           citations were resolved by search — spot-check them in /studio/qa");

  if (has("--verify") && ids.length > 0) {
    let ok = 0;
    for (const id of ids) {
      const { status } = await jpatch(`/qa/${id}/verify`, { reviewer: "seed" });
      if (status === 200) ok++;
    }
    console.log(`           ${ok}/${ids.length} verified (--verify)`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`Loading Lao accounting seed corpus → ${API}\n`);

const health = await fetch(`${API}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`rag-api not reachable at ${API}. Start it (bun run start) or set RAG_API_URL.`);
  process.exit(1);
}

if (!has("--skip-knowledge")) await loadKnowledge();
if (!has("--skip-accounts")) await loadAccounts();
if (!has("--skip-glossary")) await loadGlossary();
if (!has("--skip-qa")) await loadQa();

if (has("--assign-splits")) {
  const { status, json } = await jpost("/qa/assign-splits", {});
  console.log(
    status === 200
      ? `splits:    assigned by source document — ${JSON.stringify(json)}`
      : `splits:    ✗ ${status} ${errmsg(json)}`,
  );
}

console.log("\nDone.");
if (!has("--verify")) {
  console.log("Everything is unverified. Review in /studio/review, /studio/accounts,");
  console.log("/studio/glossary and /studio/qa — or re-run with --verify to auto-accept.");
}
console.log("Seed documents carry authority \"" + SEED_AUTHORITY + "\" — they are NOT real sources.");
