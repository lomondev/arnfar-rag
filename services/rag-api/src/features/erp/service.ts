import { sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import type { CitationSource } from "../chat/prompt.ts";
import { ensureDemoErp } from "./demo.ts";

/** Live-ERP read-only tools (ROADMAP Phase 3 — the moat).
 *
 *  A document bot answers "what is the VAT rate"; an ERP assistant answers
 *  "ລູກຄ້າ B ຄ້າງຊຳລະເທົ່າໃດ?" from the live database. These tools are:
 *  - READ-ONLY — plain SELECTs, never a write;
 *  - deterministic — invoked by conservative Lao intent patterns, not by the LLM
 *    (same design decision as the agent orchestrator: local generators are not
 *    reliable tool-callers, and a wrong silent call in accounting is worse than none);
 *  - cited — each result becomes a numbered [n] source with origin "erp", so the
 *    generator's cite-or-abstain rule covers live figures exactly like documents.
 *
 *  All LAK amounts flow as BIGINT → string (CLAUDE.md money rule).
 *  ERP figures are point-in-time: origin "erp" sources are never promotable into
 *  the dataset (same guard as web sources).
 */

/** postgres.js RowList rows carry a prototype Elysia won't JSON-serialize —
 *  normalize every result to plain objects (same pattern as dashboard/service). */
function plain<T>(rows: unknown): T[] {
  return Array.from(rows as ArrayLike<Record<string, unknown>>, (r) => ({ ...r })) as T[];
}

export interface ErpToolCall {
  tool: string;
  titleLo: string;
  input: Record<string, unknown>;
  result: unknown;
}

/* ── tools ────────────────────────────────────────────────────────────────── */

export async function customerOutstanding(nameFragment?: string) {
  await ensureDemoErp();
  const needle = `%${nameFragment ?? ""}%`;
  return plain<{ name_lo: string; invoiced_lak: string; paid_lak: string; outstanding_lak: string }>(await db().execute(sql`
    SELECT c.name_lo,
           coalesce(sum(i.gross_lak), 0)::text                                   AS invoiced_lak,
           coalesce((SELECT sum(p.amount_lak) FROM erp.payment p
                     JOIN erp.invoice pi ON pi.id = p.invoice_id
                     WHERE pi.customer_id = c.id), 0)::text                      AS paid_lak,
           (coalesce(sum(i.gross_lak), 0)
            - coalesce((SELECT sum(p.amount_lak) FROM erp.payment p
                        JOIN erp.invoice pi ON pi.id = p.invoice_id
                        WHERE pi.customer_id = c.id), 0))::text                  AS outstanding_lak
    FROM erp.customer c
    LEFT JOIN erp.invoice i ON i.customer_id = c.id
    WHERE c.name_lo ILIKE ${needle}
    GROUP BY c.id, c.name_lo
    ORDER BY c.name_lo
  `));
}

export async function invoiceLookup(q: string) {
  await ensureDemoErp();
  const needle = `%${q}%`;
  return plain<Record<string, string>>(await db().execute(sql`
    SELECT i.ref, c.name_lo AS customer_lo, i.issue_date::text,
           i.net_lak::text, i.vat_lak::text, i.gross_lak::text, i.status,
           coalesce((SELECT sum(p.amount_lak) FROM erp.payment p WHERE p.invoice_id = i.id), 0)::text AS paid_lak
    FROM erp.invoice i
    JOIN erp.customer c ON c.id = i.customer_id
    WHERE i.ref ILIKE ${needle} OR c.name_lo ILIKE ${needle}
    ORDER BY i.issue_date DESC
    LIMIT 10
  `));
}

export async function accountBalance(codePrefix: string) {
  await ensureDemoErp();
  return plain<{ account_code: string; debit_lak: string; credit_lak: string; balance_lak: string }>(await db().execute(sql`
    SELECT account_code,
           sum(debit_lak)::text  AS debit_lak,
           sum(credit_lak)::text AS credit_lak,
           (sum(debit_lak) - sum(credit_lak))::text AS balance_lak
    FROM erp.gl_entry
    WHERE account_code LIKE ${codePrefix + "%"}
    GROUP BY account_code
    ORDER BY account_code
  `));
}

export async function trialBalance() {
  await ensureDemoErp();
  return plain<{ account_code: string; debit_lak: string; credit_lak: string }>(await db().execute(sql`
    SELECT account_code,
           sum(debit_lak)::text  AS debit_lak,
           sum(credit_lak)::text AS credit_lak
    FROM erp.gl_entry
    GROUP BY account_code
    ORDER BY account_code
  `));
}

/* ── intent detection (conservative — fire only on clear ERP questions) ──── */

async function customerNameIn(question: string): Promise<string | null> {
  await ensureDemoErp();
  const rows = (await db().execute(sql`SELECT name_lo FROM erp.customer`)) as unknown as {
    name_lo: string;
  }[];
  // Match on the distinctive part of the name (drop the ບໍລິສັດ/ຮ້ານ/ຈຳກັດ chrome).
  for (const r of rows) {
    const core = r.name_lo.replace(/ບໍລິສັດ|ຮ້ານ|ຈຳກັດ/g, "").trim();
    const first = core.split(/\s+/)[0];
    if (first && question.includes(first)) return r.name_lo;
  }
  return null;
}

/** Detect ERP intents in a chat question and run the matching read-only tools. */
export async function detectAndRunErpTools(question: string): Promise<ErpToolCall[]> {
  const calls: ErpToolCall[] = [];
  try {
    if (/ຄ້າງຊຳລະ|ຄ້າງຈ່າຍ|ໜີ້ຄ້າງ|ຍັງຕິດໜີ້|outstanding/i.test(question)) {
      const name = await customerNameIn(question);
      const result = await customerOutstanding(name ?? undefined);
      if (result.length) {
        calls.push({
          tool: "erp_customer_outstanding",
          titleLo: name ? `ຍອດຄ້າງຊຳລະ — ${name}` : "ຍອດຄ້າງຊຳລະ ລູກຄ້າທັງໝົດ",
          input: { customer: name ?? "(all)" },
          result,
        });
      }
    }

    if (/ດຸ່ນດ່ຽງທົດລອງ|trial\s*balance/i.test(question)) {
      const result = await trialBalance();
      calls.push({ tool: "erp_trial_balance", titleLo: "ໃບດຸ່ນດ່ຽງທົດລອງ", input: {}, result });
    }

    const bal = /ຍອດ(?:ເຫຼືອ)?\s*(?:ຂອງ)?\s*ບັນຊີ\s*(?:ເລກ)?\s*(\d{2,4})/.exec(question);
    if (bal?.[1]) {
      const result = await accountBalance(bal[1]);
      if (result.length) {
        calls.push({
          tool: "erp_account_balance",
          titleLo: `ຍອດບັນຊີ ${bal[1]}`,
          input: { account: bal[1] },
          result,
        });
      }
    }

    const inv = /INV-\S+/i.exec(question);
    if (inv || /ໃບເກັບເງິນ.*(ຂອງ|ລູກຄ້າ)/.test(question)) {
      const q = inv?.[0] ?? (await customerNameIn(question));
      if (q) {
        const result = await invoiceLookup(q);
        if (result.length) {
          calls.push({
            tool: "erp_invoice_lookup",
            titleLo: `ໃບເກັບເງິນ — ${q}`,
            input: { q },
            result,
          });
        }
      }
    }
  } catch {
    // ERP tools fail soft — the chat proceeds document-only.
  }
  return calls;
}

/** Tool results → numbered citation sources with origin "erp". */
export function erpToSources(calls: ErpToolCall[], startN: number): CitationSource[] {
  return calls.map((c, i) => ({
    n: startN + i + 1,
    id: `erp:${c.tool}`,
    content: JSON.stringify(c.result, null, 1),
    headingPath: [],
    kind: "erp",
    title: c.titleLo,
    authority: "Arnfar ERP (live)",
    effectiveDate: null,
    origin: "erp" as const,
    url: null,
  }));
}
