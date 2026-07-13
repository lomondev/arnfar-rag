import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, ne } from "drizzle-orm";

import { db } from "../../lib/db.ts";

/** Mine candidate glossary terms: frequent adjacent Lao n-grams (bi/tri-grams) from
 *  content_seg. A frequent multi-token sequence whose concatenation is not a single
 *  common word is a domain-term candidate. The accountant verifies each.
 *
 *  NOTE: the strict "absent from LaoNLP dictionary" filter (PROMPT.md §5) is deferred
 *  — it needs a lao-nlp membership endpoint; frequency + human review stands in for now. */

const LAO = /[຀-໿]/;
const isLao = (tok: string): boolean => tok.length >= 2 && LAO.test(tok);

export interface TermCandidate {
  termLo: string; // concatenated (no spaces) — the surface form
  termLoSeg: string; // space-joined tokens — the segmented form
  freq: number;
}

export async function mineCandidates(
  tenant: TenantContext,
  opts: { minFreq?: number; limit?: number } = {},
): Promise<TermCandidate[]> {
  const minFreq = opts.minFreq ?? 2;
  const limit = opts.limit ?? 50;

  const rows = await db()
    .select({ seg: schema.ragChunk.contentSeg })
    .from(schema.ragChunk)
    .where(
      and(
        eq(schema.ragChunk.hfId, tenant.hfId),
        eq(schema.ragChunk.companyId, tenant.companyId),
        ne(schema.ragChunk.review, "rejected"),
      ),
    );

  const freq = new Map<string, { seg: string; n: number }>();
  for (const { seg } of rows) {
    const toks = seg.split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      for (const size of [2, 3]) {
        if (i + size > toks.length) continue;
        const gram = toks.slice(i, i + size);
        if (!gram.every(isLao)) continue;
        const segForm = gram.join(" ");
        const cur = freq.get(segForm) ?? { seg: segForm, n: 0 };
        cur.n++;
        freq.set(segForm, cur);
      }
    }
  }

  // Exclude candidates already in the glossary.
  const existing = new Set(
    (
      await db()
        .select({ termLo: schema.laoTerm.termLo })
        .from(schema.laoTerm)
        .where(
          and(
            eq(schema.laoTerm.hfId, tenant.hfId),
            eq(schema.laoTerm.companyId, tenant.companyId),
          ),
        )
    ).map((r) => r.termLo),
  );

  return [...freq.values()]
    .filter((c) => c.n >= minFreq)
    .map((c) => ({ termLo: c.seg.replace(/\s+/g, ""), termLoSeg: c.seg, freq: c.n }))
    .filter((c) => !existing.has(c.termLo))
    .sort((a, b) => b.freq - a.freq)
    .slice(0, limit);
}
