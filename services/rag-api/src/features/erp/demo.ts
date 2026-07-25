import { sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";

/** DEMO ERP data — a stand-in for the real Arnfar ERP database.
 *
 *  The tools in service.ts read plain SQL from the `erp` schema. Pointing them at the
 *  production ERP later means swapping the connection (ERP_DATABASE_URL) — the tool
 *  queries are the contract, this file is a placeholder that makes the whole loop
 *  demonstrable today. Everything is read-only from the assistant's perspective.
 *
 *  Money rule (CLAUDE.md): LAK is BIGINT everywhere, no floats, no rounding.
 *  The seed is double-entry consistent: every invoice posts Dr 411 / Cr 701 + Cr 4331,
 *  every payment posts Dr 531 / Cr 411 — so trial balance ties and
 *  customer outstanding == 411 balance by construction.
 */

let ensured = false;

export async function ensureDemoErp(): Promise<void> {
  if (ensured) return;
  await db().execute(sql`
    CREATE SCHEMA IF NOT EXISTS erp;
    CREATE TABLE IF NOT EXISTS erp.customer (
      id       serial PRIMARY KEY,
      name_lo  text NOT NULL,
      phone    text
    );
    CREATE TABLE IF NOT EXISTS erp.invoice (
      id          serial PRIMARY KEY,
      ref         text NOT NULL UNIQUE,
      customer_id int  NOT NULL REFERENCES erp.customer(id),
      issue_date  date NOT NULL,
      net_lak     bigint NOT NULL,
      vat_lak     bigint NOT NULL,
      gross_lak   bigint NOT NULL,
      status      text NOT NULL DEFAULT 'issued'
    );
    CREATE TABLE IF NOT EXISTS erp.payment (
      id          serial PRIMARY KEY,
      invoice_id  int  NOT NULL REFERENCES erp.invoice(id),
      pay_date    date NOT NULL,
      amount_lak  bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS erp.gl_entry (
      id           serial PRIMARY KEY,
      entry_date   date NOT NULL,
      account_code text NOT NULL,
      debit_lak    bigint NOT NULL DEFAULT 0,
      credit_lak   bigint NOT NULL DEFAULT 0,
      memo         text
    );
  `);

  const rows = (await db().execute(
    sql`SELECT count(*)::int AS n FROM erp.customer`,
  )) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) > 0) {
    ensured = true;
    return;
  }

  await db().execute(sql`
    INSERT INTO erp.customer (name_lo, phone) VALUES
      ('ບໍລິສັດ ວັນນະສອນ ຈຳກັດ', '020 5555 1111'),
      ('ຮ້ານ ສີສະຫວາດ',          '020 5555 2222'),
      ('ບໍລິສັດ ໄຊສະຫວັນ ຈຳກັດ', '020 5555 3333'),
      ('ຮ້ານ ພູຄຳ',              '020 5555 4444');

    INSERT INTO erp.invoice (ref, customer_id, issue_date, net_lak, vat_lak, gross_lak, status) VALUES
      ('INV-2026-001', 1, '2026-06-05', 10000000, 1000000, 11000000, 'partial'),
      ('INV-2026-002', 2, '2026-06-18',  5000000,  500000,  5500000, 'paid'),
      ('INV-2026-003', 3, '2026-07-02', 20000000, 2000000, 22000000, 'partial'),
      ('INV-2026-004', 1, '2026-07-15',  3000000,  300000,  3300000, 'issued');

    INSERT INTO erp.payment (invoice_id, pay_date, amount_lak) VALUES
      (1, '2026-06-20',  6000000),
      (2, '2026-06-30',  5500000),
      (3, '2026-07-10', 11000000);

    -- Invoices: Dr 411 gross / Cr 701 net / Cr 4331 vat
    INSERT INTO erp.gl_entry (entry_date, account_code, debit_lak, credit_lak, memo) VALUES
      ('2026-06-05','411',11000000,0,'INV-2026-001'), ('2026-06-05','701',0,10000000,'INV-2026-001'), ('2026-06-05','4331',0,1000000,'INV-2026-001'),
      ('2026-06-18','411', 5500000,0,'INV-2026-002'), ('2026-06-18','701',0, 5000000,'INV-2026-002'), ('2026-06-18','4331',0, 500000,'INV-2026-002'),
      ('2026-07-02','411',22000000,0,'INV-2026-003'), ('2026-07-02','701',0,20000000,'INV-2026-003'), ('2026-07-02','4331',0,2000000,'INV-2026-003'),
      ('2026-07-15','411', 3300000,0,'INV-2026-004'), ('2026-07-15','701',0, 3000000,'INV-2026-004'), ('2026-07-15','4331',0, 300000,'INV-2026-004'),
      -- Payments: Dr 531 cash / Cr 411
      ('2026-06-20','531', 6000000,0,'PMT INV-2026-001'), ('2026-06-20','411',0, 6000000,'PMT INV-2026-001'),
      ('2026-06-30','531', 5500000,0,'PMT INV-2026-002'), ('2026-06-30','411',0, 5500000,'PMT INV-2026-002'),
      ('2026-07-10','531',11000000,0,'PMT INV-2026-003'), ('2026-07-10','411',0,11000000,'PMT INV-2026-003');
  `);
  ensured = true;
}
