import { z } from "zod";

/**
 * Versioned dataset exports.
 *
 * `shareable` is the switch that excludes `license = 'client-confidential'` rows. It
 * defaults to the safe direction: an export is not shareable unless it says so.
 */

export const exportRequest = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver, e.g. 1.0.0"),
  shareable: z.boolean().optional(),
});
export type ExportRequest = z.infer<typeof exportRequest>;

export const manifestFile = z.object({
  name: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
  records: z.number().int(),
});
export type ManifestFile = z.infer<typeof manifestFile>;

export const exportResult = z.object({
  version: z.string(),
  dir: z.string(),
  files: z.array(manifestFile),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});
export type ExportResult = z.infer<typeof exportResult>;
