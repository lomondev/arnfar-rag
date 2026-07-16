import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";

/** Chart of accounts — extraction (ingest) or a human proposes; verified=false
 *  until a human clicks Verify. Verified rows are what exports pick up. */

export interface AccountInput {
  code: string;
  nameLo: string;
  nameEn?: string;
  parentCode?: string;
  accountClass: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: "debit" | "credit";
  statement: "BS" | "PL" | "CF" | "NONE";
}

export async function listAccounts(tenant: TenantContext, verified?: boolean) {
  const conds = [
    eq(schema.laoAccount.hfId, tenant.hfId),
    eq(schema.laoAccount.companyId, tenant.companyId),
  ];
  if (verified !== undefined) conds.push(eq(schema.laoAccount.verified, verified));
  return db()
    .select()
    .from(schema.laoAccount)
    .where(and(...conds))
    .orderBy(schema.laoAccount.code);
}

/** Returns null on duplicate account code within the tenant. */
export async function createAccount(tenant: TenantContext, input: AccountInput) {
  const res = await db()
    .insert(schema.laoAccount)
    .values({
      id: newId(),
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      code: input.code,
      nameLo: input.nameLo,
      nameEn: input.nameEn ?? null,
      parentCode: input.parentCode ?? null,
      accountClass: input.accountClass,
      normalBalance: input.normalBalance,
      statement: input.statement,
      verified: false,
      meta: { source: "manual" },
    })
    .onConflictDoNothing()
    .returning({ id: schema.laoAccount.id });
  return res[0] ?? null;
}

/** Any content edit resets verified=false — a human must re-confirm. */
export async function updateAccount(
  tenant: TenantContext,
  id: string,
  patch: Partial<AccountInput>,
) {
  const set: Record<string, unknown> = {};
  if (patch.code !== undefined) set.code = patch.code;
  if (patch.nameLo !== undefined) set.nameLo = patch.nameLo;
  if (patch.nameEn !== undefined) set.nameEn = patch.nameEn || null;
  if (patch.parentCode !== undefined) set.parentCode = patch.parentCode || null;
  if (patch.accountClass !== undefined) set.accountClass = patch.accountClass;
  if (patch.normalBalance !== undefined) set.normalBalance = patch.normalBalance;
  if (patch.statement !== undefined) set.statement = patch.statement;
  if (Object.keys(set).length === 0) return null;
  set.verified = false;
  const res = await db()
    .update(schema.laoAccount)
    .set(set)
    .where(
      and(
        eq(schema.laoAccount.id, id),
        eq(schema.laoAccount.hfId, tenant.hfId),
        eq(schema.laoAccount.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoAccount.id });
  return res[0] ?? null;
}

export async function verifyAccount(tenant: TenantContext, id: string) {
  const res = await db()
    .update(schema.laoAccount)
    .set({ verified: true })
    .where(
      and(
        eq(schema.laoAccount.id, id),
        eq(schema.laoAccount.hfId, tenant.hfId),
        eq(schema.laoAccount.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoAccount.id });
  return res[0] ?? null;
}

export async function deleteAccount(tenant: TenantContext, id: string) {
  const res = await db()
    .delete(schema.laoAccount)
    .where(
      and(
        eq(schema.laoAccount.id, id),
        eq(schema.laoAccount.hfId, tenant.hfId),
        eq(schema.laoAccount.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoAccount.id });
  return res[0] ?? null;
}
