import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";

export interface GlossaryMatch {
  en: string;
  lo: string;
}

/** Glossary query expansion — if the query contains an English accounting term that
 *  is a verified lao_term.term_en, append its segmented Lao form to the LEXICAL query.
 *  This disproportionately fixes the "user asks in English, corpus is Lao" case.
 *  Only the lexical side is expanded; bge-m3 is multilingual so the dense side already
 *  bridges languages. */
export async function expandWithGlossary(
  rawQuery: string,
  tenant: TenantContext,
): Promise<{ extraSeg: string; matched: GlossaryMatch[] }> {
  const lower = rawQuery.toLowerCase();
  const terms = await db()
    .select({
      termEn: schema.laoTerm.termEn,
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
  for (const t of terms) {
    if (t.termEn && lower.includes(t.termEn.toLowerCase())) {
      matched.push({ en: t.termEn, lo: t.termLoSeg });
      segs.push(t.termLoSeg);
    }
  }
  return { extraSeg: segs.join(" "), matched };
}
