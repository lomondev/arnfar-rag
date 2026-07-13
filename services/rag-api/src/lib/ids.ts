import { uuidv7 } from "uuidv7";

/** UUIDv7 for all cross-service identifiers, generated application-side
 *  (Postgres 16 has no native uuidv7()). Time-ordered → index-friendly. */
export function newId(): string {
  return uuidv7();
}
