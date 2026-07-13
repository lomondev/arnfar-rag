import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDb>;

/**
 * Create a Drizzle client backed by postgres-js.
 *
 * LAK amounts are BIGINT everywhere; postgres-js returns bigint columns as strings
 * by default, which is what we want — currency never round-trips through a JS number.
 */
export function createDb(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 10,
    // Parse int8/BIGINT to native JS bigint (exact) — never a float. LAK stays precise.
    types: {
      bigint: postgres.BigInt,
    },
  });
  return drizzle(sql, { schema, casing: "snake_case" });
}
