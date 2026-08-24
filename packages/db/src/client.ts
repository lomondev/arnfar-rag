import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";
import type { TenantContext } from "./tenant.ts";

export type Database = ReturnType<typeof createDb>;

export interface CreateDbOptions {
  /**
   * Tenant to bind every connection in this pool to. Required in the application; the
   * row-level security policies (migration 0003) compare against the session GUCs this
   * sets, so an unbound pool reads zero rows from every tenant-scoped table.
   *
   * Omit it only for tooling that legitimately works across tenants — migrations, the
   * HNSW build, benchmarks — which must run as a role that owns the tables.
   */
  readonly tenant?: TenantContext;
  /** Pool size. Default 10. */
  readonly max?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Startup-parameter string binding the connection to a tenant.
 *
 * The tenant is set here, at connection open, rather than per query or per transaction.
 * That choice is what lets RLS cover all 139 existing call sites without rewriting them:
 * every query on every pooled connection is already scoped, including the raw `sql``
 * blocks that a query-builder helper could never reach.
 *
 * The ids are validated as UUIDs first. They reach this function from configuration
 * rather than from a request, but this string is concatenated into a connection
 * parameter — the one place in the codebase where a stray value would not be
 * parameterised — so it is checked rather than trusted.
 */
function tenantConnectionOptions(tenant: TenantContext): string {
  for (const [field, value] of [
    ["hfId", tenant.hfId],
    ["companyId", tenant.companyId],
  ] as const) {
    if (!UUID_RE.test(value)) {
      throw new Error(`tenant.${field} is not a UUID: ${JSON.stringify(value)}`);
    }
  }
  return `-c arnfar.hf_id=${tenant.hfId} -c arnfar.company_id=${tenant.companyId}`;
}

/**
 * Create a Drizzle client backed by postgres-js.
 *
 * LAK amounts are BIGINT everywhere; postgres-js returns bigint columns as strings
 * by default, which is what we want — currency never round-trips through a JS number.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    // Parse int8/BIGINT to native JS bigint (exact) — never a float. LAK stays precise.
    types: {
      bigint: postgres.BigInt,
    },
    ...(options.tenant ? { connection: { options: tenantConnectionOptions(options.tenant) } } : {}),
  });
  return drizzle(sql, { schema, casing: "snake_case" });
}

/** What a connection reports about its own tenant scoping and RLS exposure. */
export interface TenantBindingCheck {
  role: string;
  /** True when this role is exempt from row security — RLS policies do nothing for it. */
  bypassesRls: boolean;
  hfId: string | null;
  companyId: string | null;
}

/**
 * Ask the database what it thinks this connection is.
 *
 * Two things can silently disable tenant isolation: connecting as a SUPERUSER or
 * BYPASSRLS role (Postgres exempts both from row security unconditionally, regardless of
 * FORCE ROW LEVEL SECURITY), or connecting without the tenant GUCs set. Neither shows up
 * as an error — the first quietly returns everything, the second quietly returns nothing.
 * The service calls this at startup so both states are stated out loud instead of guessed.
 */
export async function checkTenantBinding(database: Database): Promise<TenantBindingCheck> {
  const rows = await database.$client<
    { role: string; bypasses_rls: boolean; hf_id: string | null; company_id: string | null }[]
  >`
    SELECT current_user AS role,
           COALESCE(r.rolsuper, false) OR COALESCE(r.rolbypassrls, false) AS bypasses_rls,
           NULLIF(current_setting('arnfar.hf_id', true), '')      AS hf_id,
           NULLIF(current_setting('arnfar.company_id', true), '') AS company_id
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const row = rows[0];
  if (!row) throw new Error("could not resolve current_user");
  return {
    role: row.role,
    bypassesRls: row.bypasses_rls,
    hfId: row.hf_id,
    companyId: row.company_id,
  };
}
