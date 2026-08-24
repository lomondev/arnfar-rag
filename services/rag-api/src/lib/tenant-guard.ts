import { checkTenantBinding } from "@arnfar/db";

import { db } from "./db.ts";
import { env } from "./env.ts";
import { log } from "./logger.ts";

const glog = log.child("tenant");

/**
 * Verify at startup that tenant isolation is actually in force.
 *
 * The row-level security policies (migration 0003) have two silent failure modes, and
 * neither surfaces as an error at query time:
 *
 *   1. Connected as SUPERUSER or BYPASSRLS — Postgres exempts those roles from row
 *      security unconditionally, so every policy is skipped and every query sees every
 *      tenant. This is the default state of a `docker compose` cluster, which is exactly
 *      why it needs saying out loud.
 *   2. Connected without the tenant GUCs — every tenant-scoped table reads as empty,
 *      which looks like a data-loss bug rather than a configuration one.
 *
 * In production (NODE_ENV=production) the first case is fatal: shipping a build that
 * silently serves one client's ledger to another is not a warning. In development it is a
 * loud warning, because a single-tenant dev box with the superuser URL is a reasonable
 * place to be — as long as nobody mistakes it for the enforced configuration.
 */
export async function assertTenantIsolation(): Promise<void> {
  let binding: Awaited<ReturnType<typeof checkTenantBinding>>;
  try {
    binding = await checkTenantBinding(db());
  } catch (err) {
    glog.error("could not verify tenant isolation", err);
    return;
  }

  const { role, bypassesRls, hfId, companyId } = binding;

  if (!hfId || !companyId) {
    glog.error("connection has no tenant bound — every tenant-scoped table will read empty", {
      role,
      hfId,
      companyId,
    });
    return;
  }

  if (hfId !== env.devHfId || companyId !== env.devCompanyId) {
    glog.error("connection is bound to a different tenant than configured", {
      role,
      connectionHfId: hfId,
      configuredHfId: env.devHfId,
    });
    return;
  }

  if (bypassesRls) {
    const message =
      "connected as a role that BYPASSES row-level security — tenant policies are inert";
    const remedy = "run `bun run db:app-role`, then point DATABASE_URL at that role";
    if (process.env.NODE_ENV === "production") {
      glog.error(`${message}; refusing to serve`, undefined, { role, remedy });
      process.exit(1);
    }
    glog.warn(message, { role, remedy });
    return;
  }

  glog.info("tenant isolation enforced by RLS", { role, hfId, companyId });
}
