import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";

export interface GlossaryMatch {
  en: string;
  lo: string;
  /** Which side of the term the query matched. `en` means the user wrote the English
   *  term and the Lao form was added; `lo` is the reverse. */
  matchedOn: "en" | "lo";
}

/**
 * Glossary query expansion — bridge the query into whichever language the corpus is not.
 *
 * The lexical arm searches `content_seg`, a `tsvector` of LaoNLP-segmented text. It is
 * exact-match by construction, so a query in the wrong language scores zero there and the
 * dense arm is left retrieving alone. Verified `lao_term` rows are the bridge, and they
 * work in both directions:
 *
 *   - the query contains an English term → append its segmented Lao form
 *     ("what is the VAT rate" now also searches ອາກອນ ມູນຄ່າ ເພີ່ມ);
 *   - the query contains a Lao term → append its English form
 *     (ອາກອນມູນຄ່າເພີ່ມ now also searches "value-added tax", which matters because Lao
 *     accounting documents carry English headings, account names and form codes).
 *
 * Only the LEXICAL side is expanded. bge-m3 is multilingual, so the dense arm already
 * bridges languages on its own — and appending translations to the dense input would
 * corrupt the very embedding it is meant to help.
 *
 * Verified terms only. An unverified draft is a proposal, and query expansion is not the
 * place to find out it was wrong.
 */
export async function expandWithGlossary(
  rawQuery: string,
  tenant: TenantContext,
): Promise<{ extraSeg: string; matched: GlossaryMatch[] }> {
  const lower = rawQuery.toLowerCase();
  const terms = await db()
    .select({
      termEn: schema.laoTerm.termEn,
      termLo: schema.laoTerm.termLo,
      termLoSeg: schema.laoTerm.termLoSeg,
    })
    .from(schema.laoTerm)
    .where(
      and(
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
        eq(schema.laoTerm.verified, true),
      ),
    );

  const matched: GlossaryMatch[] = [];
  const segs: string[] = [];
  const seen = new Set<string>();

  for (const t of terms) {
    if (!t.termEn) continue;

    // EN in the query → add the Lao. Case-folded because English accounting terms are
    // written every which way ("VAT", "Vat", "vat") while the Lao side is not cased.
    if (lower.includes(t.termEn.toLowerCase())) {
      if (!seen.has(t.termLoSeg)) {
        seen.add(t.termLoSeg);
        segs.push(t.termLoSeg);
      }
      matched.push({ en: t.termEn, lo: t.termLoSeg, matchedOn: "en" });
      continue;
    }

    // LO in the query → add the English. Matched against the UNSEGMENTED Lao form: a user
    // types ອາກອນມູນຄ່າເພີ່ມ without spaces, so testing the segmented form would never hit.
    if (t.termLo && rawQuery.includes(t.termLo)) {
      if (!seen.has(t.termEn)) {
        seen.add(t.termEn);
        segs.push(t.termEn);
      }
      matched.push({ en: t.termEn, lo: t.termLo, matchedOn: "lo" });
    }
  }

  return { extraSeg: segs.join(" "), matched };
}
