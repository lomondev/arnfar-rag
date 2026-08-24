/**
 * Tenant context threaded through every tenant-scoped query.
 *
 * Constraint (CLAUDE.md): no query touches a tenant-scoped table without
 * `hf_id = $hf AND company_id = $company` in its WHERE clause.
 *
 * That constraint is enforced by the database, not by this type and not by convention.
 * createDb() binds this context to every connection as the `arnfar.hf_id` /
 * `arnfar.company_id` session GUCs, and the row-level security policies in migration
 * 0003 compare each row against them. The explicit predicates in the query files remain
 * — they keep intent visible and let the planner use the tenant indexes — but they are
 * no longer what makes isolation true.
 *
 * Two caveats worth knowing before trusting it:
 *   - Postgres exempts SUPERUSER and BYPASSRLS roles from row security. Run the app as
 *     the role created by `bun run db:app-role`, not as the cluster superuser.
 *   - A connection with no tenant bound reads zero rows, not all rows. That is the
 *     intended failure direction, and it is loud in a way the old one was not.
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
