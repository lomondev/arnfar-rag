import { z } from "zod";

/** Chart-of-accounts rows. `verified` is false until a human confirms (CLAUDE.md). */

export const normalBalance = z.enum(["debit", "credit"]);
export type NormalBalance = z.infer<typeof normalBalance>;

export const statement = z.enum(["BS", "PL", "CF", "NONE"]);
export type Statement = z.infer<typeof statement>;

export const account = z.object({
  id: z.string(),
  code: z.string(),
  nameLo: z.string(),
  nameEn: z.string().nullable(),
  parentCode: z.string().nullable(),
  accountClass: z.string(),
  normalBalance: z.string(),
  statement: z.string(),
  verified: z.boolean(),
});
export type Account = z.infer<typeof account>;
