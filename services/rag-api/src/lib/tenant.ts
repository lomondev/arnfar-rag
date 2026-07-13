import type { TenantContext } from "@arnfar/db";

import { env } from "./env.ts";

/** Dev single-tenant context. In production this comes from the auth layer;
 *  the tenant filter is applied on every query regardless (CLAUDE.md). */
export function devTenant(): TenantContext {
  return env.devBranchId
    ? { hfId: env.devHfId, companyId: env.devCompanyId, branchId: env.devBranchId }
    : { hfId: env.devHfId, companyId: env.devCompanyId };
}
