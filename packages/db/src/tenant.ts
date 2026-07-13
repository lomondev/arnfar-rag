/**
 * Tenant context threaded through every tenant-scoped query.
 *
 * Constraint (CLAUDE.md): no query touches a tenant-scoped table without
 * `hf_id = $hf AND company_id = $company` in its WHERE clause. This type is the
 * carrier; the query helpers that consume it land with the schema phase.
 */
export interface TenantContext {
  readonly hfId: string; // UUIDv7
  readonly companyId: string; // UUIDv7
  readonly branchId?: string; // UUIDv7, optional
}

export function tenantFromEnv(env: Record<string, string | undefined>): TenantContext {
  const hfId = env.DEV_HF_ID;
  const companyId = env.DEV_COMPANY_ID;
  if (!hfId || !companyId) {
    throw new Error("DEV_HF_ID and DEV_COMPANY_ID must be set (see .env.example)");
  }
  const branchId = env.DEV_BRANCH_ID;
  return branchId ? { hfId, companyId, branchId } : { hfId, companyId };
}
