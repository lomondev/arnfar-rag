import { z } from "zod";

/** UUIDv7 string. Validated as a UUID; version-7 ordering is a generation concern. */
export const uuid = z.string().uuid();

/** Tenant context — present on every tenant-scoped request. */
export const tenantContext = z.object({
  hfId: uuid,
  companyId: uuid,
  branchId: uuid.optional(),
});
export type TenantContext = z.infer<typeof tenantContext>;

/** Corpus collections (see rag_document.collection). */
export const collection = z.enum([
  "lao-accounting-law",
  "coa",
  "tax",
  "sop",
  "lao-style",
]);
export type Collection = z.infer<typeof collection>;

/** Language tag used across documents, chunks, and detection. */
export const lang = z.enum(["lo", "en", "th", "mixed"]);
export type Lang = z.infer<typeof lang>;
