# Connecting Arnfar AI to your real ERP database

The assistant answers live-data questions ("ລູກຄ້າ … ຄ້າງຊຳລະເທົ່າໃດ?") by SELECTing
from **three SQL views** in the ERP database. The views are the whole contract: map
your ERP's own tables into them and the assistant works — no code changes.

Unset `ERP_DATABASE_URL` = the bundled demo data (the demo's own views over
`erp.*` are a living example of this contract).

## 1. Create a read-only role in your ERP database

```sql
CREATE ROLE arnfar_ai LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE your_erp_db TO arnfar_ai;
GRANT USAGE ON SCHEMA public TO arnfar_ai;
-- grant SELECT only on the three views (below), nothing else:
GRANT SELECT ON arnfar_ai_customer, arnfar_ai_invoice, arnfar_ai_gl_entry TO arnfar_ai;
```

The assistant only ever reads. A read-only role makes that a database guarantee,
not a promise.

## 2. Create the three contract views (map YOUR tables)

Adjust the `FROM`/column mapping to your schema — the output columns are the contract:

```sql
-- Who your customers are
CREATE OR REPLACE VIEW arnfar_ai_customer AS
SELECT  id,                     -- any unique id
        customer_name AS name_lo, -- display name (Lao)
        phone
FROM    your_customers_table;

-- Invoices with amounts in INTEGER LAK (bigint — never floats) and paid-to-date
CREATE OR REPLACE VIEW arnfar_ai_invoice AS
SELECT  inv.id,
        inv.invoice_no                 AS ref,
        inv.customer_id,
        cust.customer_name             AS customer_lo,
        inv.invoice_date               AS issue_date,
        inv.amount_before_vat::bigint  AS net_lak,
        inv.vat_amount::bigint         AS vat_lak,
        inv.total_amount::bigint       AS gross_lak,
        inv.status,
        coalesce(paid.total, 0)::bigint AS paid_lak
FROM    your_invoices_table inv
JOIN    your_customers_table cust ON cust.id = inv.customer_id
LEFT JOIN LATERAL (
        SELECT sum(amount) AS total FROM your_payments_table p
        WHERE p.invoice_id = inv.id) paid ON true;

-- General ledger lines (drives account balance + trial balance)
CREATE OR REPLACE VIEW arnfar_ai_gl_entry AS
SELECT  entry_date,
        account_code,
        debit::bigint  AS debit_lak,
        credit::bigint AS credit_lak,
        description    AS memo
FROM    your_gl_table;
```

## 3. Point the assistant at it

In `.env`:

```
ERP_DATABASE_URL=postgres://arnfar_ai:<password>@<erp-host>:5432/your_erp_db
```

Restart rag-api (`./scripts/dev.sh stop && ./scripts/dev.sh`).

## 4. Verify

```
curl http://localhost:7730/erp/status
# → { "mode": "external", "connected": true,
#     "views": { "arnfar_ai_customer": 812, "arnfar_ai_invoice": 15230, "arnfar_ai_gl_entry": 90411 } }
```

Then ask in /chat: **"ລູກຄ້າ <ຊື່ຈິງ> ຍັງຄ້າງຊຳລະ ເທົ່າໃດ?"** — the answer must cite an
`erp` source (emerald badge, authority "Arnfar ERP (live)").

## Notes

- **Postgres only** for now. A MySQL/MSSQL ERP needs either a foreign-data-wrapper in a
  small Postgres, or a driver addition in `lib/erpdb.ts` — the view contract stays the same.
- ERP figures are point-in-time: the assistant cites them but they are never written into
  the training dataset (origin `erp` is unpromotable by design).
- Questions the intent patterns recognise today: customer outstanding (ຄ້າງຊຳລະ…),
  invoice lookup (ໃບເກັບເງິນ / INV-refs), account balance (ຍອດບັນຊີ <code>),
  trial balance (ໃບດຸ່ນດ່ຽງທົດລອງ). Extend patterns in `features/erp/service.ts`.
