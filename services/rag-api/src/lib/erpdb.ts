import { createDb, type Database } from "@arnfar/db";

import { env } from "./env.ts";
import { db } from "./db.ts";

/** Connection to the COMPANY'S ERP DATABASE — the real one when ERP_DATABASE_URL is
 *  set, the app's own database (demo `erp` schema) otherwise.
 *
 *  The integration contract is three SQL views the ERP side provides
 *  (docs/ERP-INTEGRATION.md): arnfar_ai_customer, arnfar_ai_invoice,
 *  arnfar_ai_gl_entry. The assistant's tools only ever SELECT from those views, so:
 *  - any ERP schema can be mapped without touching this codebase;
 *  - the blast radius is whatever the view exposes — connect a READ-ONLY role;
 *  - swapping demo → production is exactly one env var.
 */

let _erpDb: Database | null = null;

export function erpMode(): "external" | "demo" {
  return env.erpDatabaseUrl ? "external" : "demo";
}

export function erpDb(): Database {
  if (env.erpDatabaseUrl) {
    if (_erpDb === null) _erpDb = createDb(env.erpDatabaseUrl);
    return _erpDb;
  }
  return db();
}
