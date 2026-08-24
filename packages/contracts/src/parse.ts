import type { z } from "zod";

/**
 * Parse an API response against its contract.
 *
 * This is what makes `@arnfar/contracts` load-bearing rather than decorative. Types alone
 * are erased at runtime: if rag-api renames a field, both sides still compile and the UI
 * quietly renders `undefined`. Parsing here turns that into a named error at the fetch
 * boundary, naming the endpoint and the field that moved.
 *
 * Deliberately throws rather than returning a result type — a contract violation is a
 * bug, not a condition to branch on, and every caller already sits behind an error
 * boundary.
 */
export function parseResponse<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  endpoint: string,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`${endpoint} returned data that does not match its contract — ${detail}`);
}
