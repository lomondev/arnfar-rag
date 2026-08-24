import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

/**
 * Two-tenant isolation, asserted against a real database.
 *
 * This is the test the codebase most needed: tenant isolation used to be a convention
 * repeated across 139 query sites, and one forgotten predicate would have leaked one
 * company's ledger into another's answers with no error, no type failure, and nothing
 * to notice it.
 *
 * Skipped when no database is configured, so `bun test` stays green on a machine with
 * nothing running. CI always provides one, so the skip cannot quietly become permanent.
 *
 *   ADMIN_DATABASE_URL — owner/superuser connection, used only to seed tenant B.
 *   DATABASE_URL       — the unprivileged app role, which is what RLS actually governs.
 */

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;
const HF_A = process.env.DEV_HF_ID;
const CO_A = process.env.DEV_COMPANY_ID;

// Fixed ids, so a crashed run leaves rows the next run can find and clean up.
const HF_B = "018f9a1e-7c00-7000-8000-00000000fb01";
const CO_B = "018f9a1e-7c00-7000-8000-00000000fb02";
const DOC_B = "018f9a1e-7c00-7000-8000-00000000fbd1";

const configured = Boolean(ADMIN_URL && APP_URL && HF_A && CO_A);

const TENANT_TABLES = [
  "eval_result",
  "eval_run",
  "ingest_job",
  "knowledge_kind",
  "lao_account",
  "lao_qa_pair",
  "lao_term",
  "outbox_event",
  "rag_chunk",
  "rag_conversation",
  "rag_document",
  "rag_message",
] as const;

function connect(url: string, hfId?: string, companyId?: string) {
  return postgres(url, {
    max: 1,
    onnotice: () => {},
    ...(hfId && companyId
      ? { connection: { options: `-c arnfar.hf_id=${hfId} -c arnfar.company_id=${companyId}` } }
      : {}),
  });
}

/**
 * Run a statement and report whether the database refused it.
 *
 * Deliberately not `expect(query).rejects` — a postgres-js tagged template is a lazy
 * thenable that only executes when awaited, and handing it to a rejection matcher leaves
 * it un-executed and the test hanging forever.
 */
async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(!configured)("row-level security", () => {
  let admin: ReturnType<typeof connect>;
  let asA: ReturnType<typeof connect>;
  let asB: ReturnType<typeof connect>;
  let unscoped: ReturnType<typeof connect>;
  let appRoleBypassesRls = true;

  beforeAll(async () => {
    admin = connect(ADMIN_URL as string);
    asA = connect(APP_URL as string, HF_A as string, CO_A as string);
    asB = connect(APP_URL as string, HF_B, CO_B);
    unscoped = connect(APP_URL as string);

    const [role] = await asA<{ bypasses: boolean }[]>`
      SELECT COALESCE(rolsuper, false) OR COALESCE(rolbypassrls, false) AS bypasses
      FROM pg_roles WHERE rolname = current_user
    `;
    appRoleBypassesRls = role?.bypasses !== false;

    await admin`DELETE FROM rag_document WHERE hf_id = ${HF_B}`;
    await admin`
      INSERT INTO rag_document
        (id, hf_id, company_id, collection, title, source_filename, source_uri,
         content_sha256, lang, license)
      VALUES
        (${DOC_B}, ${HF_B}, ${CO_B}, 'tax', 'TENANT-B-CONFIDENTIAL', 'b.docx', 'test://b',
         ${"b".repeat(64)}, 'lo', 'internal')
    `;
  });

  afterAll(async () => {
    await admin`DELETE FROM rag_document WHERE hf_id = ${HF_B}`;
    await Promise.all([admin.end(), asA.end(), asB.end(), unscoped.end()]);
  });

  test("the application role does not bypass row security", () => {
    // If this fails, every assertion below is meaningless — Postgres exempts SUPERUSER
    // and BYPASSRLS roles from row security no matter what the policies say.
    expect(appRoleBypassesRls).toBe(false);
  });

  test("every tenant-scoped table has row security enabled and forced", async () => {
    const rows = await admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname IN ${admin(TENANT_TABLES)}
      ORDER BY relname
    `;
    expect(rows.map((r) => r.relname)).toEqual([...TENANT_TABLES]);
    // Reported per table so a failure names the table that is missing a policy.
    const unprotected = rows
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity)
      .map((r) => r.relname);
    expect(unprotected).toEqual([]);
  });

  test("tenant A cannot see tenant B's document by id", async () => {
    const [row] = await asA<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rag_document WHERE id = ${DOC_B}
    `;
    expect(row?.n).toBe(0);
  });

  test("tenant A cannot see it when asking for every row", async () => {
    // The unfiltered query is the point: this is what a future call site that forgot
    // its tenant predicate would run.
    const rows = await asA<{ title: string }[]>`SELECT title FROM rag_document`;
    expect(rows.map((r) => r.title)).not.toContain("TENANT-B-CONFIDENTIAL");
  });

  test("tenant B sees its own document", async () => {
    const [row] = await asB<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rag_document WHERE id = ${DOC_B}
    `;
    expect(row?.n).toBe(1);
  });

  test("tenant A cannot insert a row belonging to tenant B", async () => {
    // WITH CHECK, not just USING — isolation that covers only reads still lets one
    // tenant plant rows in another's corpus.
    const blocked = await refused(
      () => asA`
        INSERT INTO rag_document
          (id, hf_id, company_id, collection, title, source_filename, source_uri,
           content_sha256, lang, license)
        VALUES
          (gen_random_uuid(), ${HF_B}, ${CO_B}, 'tax', 'FORGED', 'f.docx', 'test://forge',
           ${"f".repeat(64)}, 'lo', 'internal')
      `,
    );
    expect(blocked).toBe(true);
  });

  test("tenant A cannot reassign one of its own rows to tenant B", async () => {
    const blocked = await refused(
      () => asA`
        UPDATE rag_document SET hf_id = ${HF_B}, company_id = ${CO_B}
        WHERE id = (SELECT id FROM rag_document ORDER BY id LIMIT 1)
      `,
    );
    expect(blocked).toBe(true);
  });

  test("tenant A cannot delete tenant B's document", async () => {
    await asA`DELETE FROM rag_document WHERE id = ${DOC_B}`;
    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rag_document WHERE id = ${DOC_B}
    `;
    // The DELETE succeeds and affects nothing — the row is simply not visible to A.
    expect(row?.n).toBe(1);
  });

  test("a connection with no tenant bound reads nothing, rather than everything", async () => {
    // The direction of this failure is the whole design: an unconfigured connection
    // must starve, never over-share.
    const [row] = await unscoped<{ n: number }[]>`SELECT count(*)::int AS n FROM rag_document`;
    expect(row?.n).toBe(0);
  });
});
