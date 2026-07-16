import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { generate } from "../../lib/ollama.ts";
import { segment } from "../../lib/sidecars.ts";
import { mineCandidates } from "./mining.ts";

/** LLM drafts the English gloss; a human verifies. verified=false until then. */
async function draftGloss(termLo: string): Promise<string> {
  const raw = await generate(
    `Lao accounting term: "${termLo}". Give ONLY its short English accounting ` +
      `equivalent as JSON: {"en": "..."}. No explanation.`,
    { json: true, temperature: 0.1, maxTokens: 60 },
  );
  try {
    const p = JSON.parse(raw) as { en?: string };
    return (p.en ?? "").trim();
  } catch {
    return "";
  }
}

export async function mineAndDraft(
  tenant: TenantContext,
  opts: { minFreq?: number; limit?: number; gloss?: boolean } = {},
) {
  const candidates = await mineCandidates(tenant, opts);
  const created: Array<{ id: string; termLo: string; termEn: string; freq: number }> = [];
  for (const c of candidates) {
    const termEn = opts.gloss ? await draftGloss(c.termLo) : "";
    const id = newId();
    await db()
      .insert(schema.laoTerm)
      .values({
        id,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        termLo: c.termLo,
        termLoSeg: c.termLoSeg,
        termEn: termEn || "(needs gloss)",
        domain: "accounting",
        verified: false,
      })
      .onConflictDoNothing();
    created.push({ id, termLo: c.termLo, termEn, freq: c.freq });
  }
  return { candidates: candidates.length, created };
}

export async function listTerms(tenant: TenantContext, verified?: boolean) {
  const conds = [
    eq(schema.laoTerm.hfId, tenant.hfId),
    eq(schema.laoTerm.companyId, tenant.companyId),
  ];
  if (verified !== undefined) conds.push(eq(schema.laoTerm.verified, verified));
  return db()
    .select()
    .from(schema.laoTerm)
    .where(and(...conds))
    .orderBy(schema.laoTerm.termLo);
}

export interface TermCreate {
  termLo: string;
  termEn: string;
  definitionLo?: string;
  definitionEn?: string;
  variantsLo?: string[];
  forbiddenLo?: string[];
  domain?: string;
}

/** Manual term entry. termLoSeg comes from the lao-nlp sidecar so lexical lookup
 *  matches mined terms. Returns null on duplicate (hf, company, termLo, domain). */
export async function createTerm(tenant: TenantContext, input: TermCreate) {
  const seg = await segment(input.termLo);
  const res = await db()
    .insert(schema.laoTerm)
    .values({
      id: newId(),
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      termLo: input.termLo,
      termLoSeg: seg.seg_text,
      termEn: input.termEn,
      definitionLo: input.definitionLo ?? null,
      definitionEn: input.definitionEn ?? null,
      variantsLo: input.variantsLo ?? [],
      forbiddenLo: input.forbiddenLo ?? [],
      domain: input.domain ?? "accounting",
      verified: false,
    })
    .onConflictDoNothing()
    .returning({ id: schema.laoTerm.id });
  return res[0] ?? null;
}

export async function deleteTerm(tenant: TenantContext, id: string) {
  const res = await db()
    .delete(schema.laoTerm)
    .where(
      and(
        eq(schema.laoTerm.id, id),
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoTerm.id });
  return res[0] ?? null;
}

export interface TermUpdate {
  termEn?: string;
  definitionLo?: string;
  definitionEn?: string;
  variantsLo?: string[];
  forbiddenLo?: string[];
}

export async function updateTerm(tenant: TenantContext, id: string, patch: TermUpdate) {
  const set: Record<string, unknown> = {};
  if (patch.termEn !== undefined) set.termEn = patch.termEn;
  if (patch.definitionLo !== undefined) set.definitionLo = patch.definitionLo;
  if (patch.definitionEn !== undefined) set.definitionEn = patch.definitionEn;
  if (patch.variantsLo !== undefined) set.variantsLo = patch.variantsLo;
  if (patch.forbiddenLo !== undefined) set.forbiddenLo = patch.forbiddenLo;
  if (Object.keys(set).length === 0) return null;
  const res = await db()
    .update(schema.laoTerm)
    .set(set)
    .where(
      and(
        eq(schema.laoTerm.id, id),
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoTerm.id });
  return res[0] ?? null;
}

export async function verifyTerm(tenant: TenantContext, id: string, verifiedBy: string) {
  const res = await db()
    .update(schema.laoTerm)
    .set({ verified: true, verifiedBy })
    .where(
      and(
        eq(schema.laoTerm.id, id),
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
      ),
    )
    .returning({ id: schema.laoTerm.id });
  return res[0] ?? null;
}
