import { createDb, type Database } from "@arnfar/db";

import { env } from "./env.ts";

let _db: Database | null = null;

/** Shared Drizzle client. */
export function db(): Database {
  if (_db === null) {
    _db = createDb(env.databaseUrl, {
      // Every pooled connection is opened already scoped to the tenant, so the row-level
      // security policies in migration 0003 have a value to compare against. See
      // packages/db/src/client.ts for why this is a connection property and not a
      // per-query one.
      tenant: { hfId: env.devHfId, companyId: env.devCompanyId },
    });
  }
  return _db;
}

/**
 * Drain and close the pool. Called only from the shutdown path — a closed pool cannot be
 * reopened by db(), which would hand later callers a dead client instead of an error.
 */
export async function closeDb(): Promise<void> {
  const current = _db;
  if (current === null) return;
  _db = null;
  await current.$client.end({ timeout: 5 });
}
