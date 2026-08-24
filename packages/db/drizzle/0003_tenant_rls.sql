-- Tenant isolation, enforced by Postgres instead of by convention.
--
-- Until now every tenant-scoped query hand-wrote `hf_id = $1 AND company_id = $2`, across
-- 28 files and 139 call sites. The filter was genuinely present everywhere, but nothing
-- *made* it present: one forgotten predicate in a future query would have silently
-- returned another company's accounting data, and no test or type would have caught it.
--
-- These policies move that guarantee below the application. A query that forgets the
-- filter now returns only the current tenant's rows; a query that runs with no tenant set
-- returns nothing at all. Both are safe failures — the previous failure mode was not.
--
-- The tenant comes from two session GUCs, set on every connection at open time
-- (packages/db/src/client.ts). `current_setting(..., true)` yields NULL when unset, and
-- NULLIF guards the empty-string case, so an unconfigured connection compares NULL and
-- matches zero rows rather than erroring at cast time or, worse, matching everything.
--
-- IMPORTANT: PostgreSQL exempts SUPERUSER and BYPASSRLS roles from row security
-- unconditionally — FORCE ROW LEVEL SECURITY only subjects the table *owner*. So these
-- policies do nothing while the app connects as the cluster superuser. Create and use the
-- unprivileged role with `bun run db:app-role`; rag-api logs a loud warning at startup
-- whenever it detects it is connected in a way that bypasses these policies.

DO $$
DECLARE
  t TEXT;
  -- Every table carrying BOTH hf_id and company_id.
  tenant_tables TEXT[] := ARRAY[
    'eval_run',
    'ingest_job',
    'knowledge_kind',
    'lao_account',
    'lao_qa_pair',
    'lao_term',
    'rag_chunk',
    'rag_conversation',
    'rag_document',
    'rag_message'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the table owner is subject to the policy too. Without it, the role that
    -- owns the tables — which is the role migrations run as — silently sees everything.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          hf_id      = NULLIF(current_setting('arnfar.hf_id',      true), '')::uuid
          AND company_id = NULLIF(current_setting('arnfar.company_id', true), '')::uuid
        )
        WITH CHECK (
          hf_id      = NULLIF(current_setting('arnfar.hf_id',      true), '')::uuid
          AND company_id = NULLIF(current_setting('arnfar.company_id', true), '')::uuid
        )
    $f$, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- outbox_event carries hf_id only (it is an append-only audit log, not tenant-partitioned
-- storage), so it is scoped on that column alone.
ALTER TABLE "outbox_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "outbox_event";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "outbox_event"
  USING (hf_id = NULLIF(current_setting('arnfar.hf_id', true), '')::uuid)
  WITH CHECK (hf_id = NULLIF(current_setting('arnfar.hf_id', true), '')::uuid);--> statement-breakpoint

-- eval_result has no tenant columns of its own; it is reachable only through eval_run,
-- so it inherits that row's tenancy. The subquery is itself policy-filtered, which is
-- what makes this correct rather than circular.
ALTER TABLE "eval_result" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_result" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "eval_result";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "eval_result"
  USING (EXISTS (SELECT 1 FROM eval_run r WHERE r.id = eval_result.run_id))
  WITH CHECK (EXISTS (SELECT 1 FROM eval_run r WHERE r.id = eval_result.run_id));
