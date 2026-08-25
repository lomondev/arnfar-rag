/**
 * Report and repair embedding provenance.
 *
 *   bun run db:reembed --dry-run     # census only — always start here
 *   bun run db:reembed               # re-embed every vector not from the configured model
 *   bun run db:reembed --stamp       # claim the unknown-provenance rows without re-embedding
 *
 * Why this is a command and not part of ingest: changing OLLAMA_EMBED_MODEL should not
 * silently trigger a full-corpus re-embed the next time somebody uploads a file. Ingest
 * only fills `embedding IS NULL`; moving an existing corpus between embedding models is a
 * deliberate, expensive operation and it says so out loud.
 *
 * `--stamp` exists for one specific situation: rows embedded before migration 0004 added
 * the `embed_model` column, which you know were produced by the model you have configured
 * now. It writes provenance without touching a vector, and refuses to relabel any row that
 * already names a different model — stamping those would be forging the evidence rather
 * than fixing the data.
 *
 * Talks to Ollama directly rather than through rag-api: this is a maintenance job that runs
 * against a stopped service, and rag-api holds no state it needs.
 */
import postgres from "postgres";

/**
 * Connection, and why it is not just DATABASE_URL.
 *
 * DATABASE_URL is the unprivileged app role. A connection on it with no tenant bound sees
 * *zero* rows in every tenant-scoped table — so a naive census here reports "nothing to do"
 * on a corpus of 200k stale vectors, which is precisely the silent-wrong-answer this whole
 * column exists to prevent. Prefer an owner connection (whole corpus, all tenants); fall
 * back to the app role with the dev tenant bound; refuse to run if neither can see rows.
 */
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const url = ADMIN_URL ?? APP_URL;
const hfId = process.env.DEV_HF_ID;
const companyId = process.env.DEV_COMPANY_ID;
const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const model = process.env.OLLAMA_EMBED_MODEL ?? "bge-m3";
const batchSize = Number(process.env.REEMBED_BATCH ?? 32);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const stamp = args.has("--stamp");

if (dryRun && stamp) {
  console.error("--dry-run and --stamp are mutually exclusive");
  process.exit(1);
}
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
  console.error(`REEMBED_BATCH must be an integer in 1..256, got: ${batchSize}`);
  process.exit(1);
}

if (!url) {
  console.error("DATABASE_URL (or ADMIN_DATABASE_URL) is required");
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only bind a tenant when running on the app role — an owner connection bypasses RLS and
// should see every tenant, which is what a corpus-wide re-embed needs.
const bindTenant = !ADMIN_URL && hfId && companyId && UUID_RE.test(hfId) && UUID_RE.test(companyId);

const sql = postgres(url, {
  max: 1,
  ...(bindTenant
    ? { connection: { options: `-c arnfar.hf_id=${hfId} -c arnfar.company_id=${companyId}` } }
    : {}),
});

/** Embed a batch through Ollama. Mirrors rag-api's lib/ollama.ts embedAll contract. */
async function embedAll(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama /api/embed → ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  const vectors = body.embeddings;
  if (!vectors || vectors.length !== texts.length) {
    throw new Error(`ollama returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`);
  }
  return vectors;
}

try {
  // Prove this connection can actually see chunks before believing any count it returns.
  const [access] = await sql<{ role: string; bypasses: boolean; bound: boolean }[]>`
    SELECT current_user AS role,
           COALESCE(r.rolsuper, false) OR COALESCE(r.rolbypassrls, false) AS bypasses,
           NULLIF(current_setting('arnfar.hf_id', true), '') IS NOT NULL AS bound
    FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (!access) throw new Error("could not resolve current_user");
  if (!access.bypasses && !access.bound) {
    console.error(
      `connected as ${access.role} with no tenant bound — row-level security hides every\n` +
        "chunk, so this command would report an empty corpus no matter what is in it.\n" +
        "Set DEV_HF_ID and DEV_COMPANY_ID in .env, or point ADMIN_DATABASE_URL at the\n" +
        "table owner to work across all tenants.",
    );
    process.exit(1);
  }
  console.log(
    `connection: ${access.role}` +
      (access.bypasses ? " (owner — all tenants)" : ` (tenant ${hfId}/${companyId})`),
  );

  const census = await sql<{ model: string | null; chunks: string }[]>`
    SELECT embed_model AS model, count(*)::text AS chunks
    FROM rag_chunk
    WHERE embedding IS NOT NULL
    GROUP BY embed_model
    ORDER BY count(*) DESC
  `;

  const pending = await sql<{ chunks: string }[]>`
    SELECT count(*)::text AS chunks FROM rag_chunk WHERE embedding IS NULL
  `;

  console.log(`configured embedding model: ${model}`);
  if (census.length === 0) {
    console.log("no embedded chunks.");
  } else {
    console.log("embedded chunks by provenance:");
    for (const row of census) {
      const label = row.model ?? "(unknown — pre-0004)";
      const mark = row.model === model ? "ok" : "STALE";
      console.log(`  ${mark.padEnd(6)} ${label}: ${row.chunks}`);
    }
  }
  console.log(`awaiting first embed (embedding IS NULL): ${pending[0]?.chunks ?? "0"}`);

  // Rows whose vector was not demonstrably produced by the configured model. Unknown
  // provenance counts as stale: "probably fine" is not a property you can search on.
  const staleRows = await sql<{ chunks: string }[]>`
    SELECT count(*)::text AS chunks
    FROM rag_chunk
    WHERE embedding IS NOT NULL AND (embed_model IS NULL OR embed_model <> ${model})
  `;
  const stale = Number(staleRows[0]?.chunks ?? "0");

  if (stale === 0) {
    console.log("\nevery vector is from the configured model — nothing to do.");
  } else if (dryRun) {
    console.log(`\n${stale} chunk(s) would be re-embedded. Re-run without --dry-run.`);
  } else if (stamp) {
    const relabel = await sql<{ chunks: string }[]>`
      SELECT count(*)::text AS chunks
      FROM rag_chunk
      WHERE embedding IS NOT NULL AND embed_model IS NOT NULL AND embed_model <> ${model}
    `;
    const conflicting = Number(relabel[0]?.chunks ?? "0");
    if (conflicting > 0) {
      console.error(
        `\nrefusing to stamp: ${conflicting} chunk(s) already name a different model.\n` +
          "Those vectors really are from another model — re-embed them instead:\n" +
          "  bun run db:reembed",
      );
      process.exit(1);
    }
    const stamped = await sql`
      UPDATE rag_chunk SET embed_model = ${model}
      WHERE embedding IS NOT NULL AND embed_model IS NULL
    `;
    console.log(`\nstamped ${stamped.count} chunk(s) as ${model} (no vectors changed).`);
  } else {
    console.log(`\nre-embedding ${stale} chunk(s) with ${model}…`);
    let done = 0;
    while (true) {
      const batch = await sql<{ id: string; content_norm: string }[]>`
        SELECT id, content_norm
        FROM rag_chunk
        WHERE embedding IS NOT NULL AND (embed_model IS NULL OR embed_model <> ${model})
        ORDER BY id
        LIMIT ${batchSize}
      `;
      if (batch.length === 0) break;

      // content_norm, never content_seg — injected word-boundary spaces corrupt bge-m3's
      // own tokenization (CLAUDE.md).
      const vectors = await embedAll(batch.map((r) => r.content_norm));
      for (let i = 0; i < batch.length; i++) {
        const vec = `[${vectors[i]!.join(",")}]`;
        await sql`
          UPDATE rag_chunk
          SET embedding = ${vec}::halfvec, embed_model = ${model}
          WHERE id = ${batch[i]!.id}
        `;
      }
      done += batch.length;
      console.log(`  ${done}/${stale}`);
    }
    console.log(
      `\nre-embedded ${done} chunk(s).\n` +
        "The HNSW index was updated in place, but a full rebuild compacts it after a bulk\n" +
        "rewrite of this size:\n" +
        "  bun run db:index:hnsw   (drop the old index first if you want a true rebuild)\n" +
        "Then ANALYZE rag_chunk, and re-run /studio/eval — the recall numbers on record\n" +
        "were measured against the vectors you just replaced.",
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}
