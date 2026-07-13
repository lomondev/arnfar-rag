import { createDb, type Database } from "@arnfar/db";

import { env } from "./env.ts";

let _db: Database | null = null;

/** Shared Drizzle client. */
export function db(): Database {
  if (_db === null) {
    _db = createDb(env.databaseUrl);
  }
  return _db;
}
