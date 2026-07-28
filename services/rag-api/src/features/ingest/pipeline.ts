import { extname } from "node:path";

import { schema } from "@arnfar/db";
import { and, eq } from "drizzle-orm";

import { db } from "../../lib/db.ts";
import { newId } from "../../lib/ids.ts";
import { normalize, segment, type ExtractBlock } from "../../lib/sidecars.ts";
import { originalKey, put, sha256 } from "../../lib/storage.ts";
import { chunkBlocks, type SegBlock } from "./chunker.ts";
import { extractFile } from "./extract.ts";
import { inferAccountAttrs } from "./accounts.ts";
import { fixLaoDefects } from "../lao/clean.ts";

export interface Tenant {
  hfId: string;
  companyId: string;
  branchId?: string | null;
}

export interface IngestInput {
  bytes: Uint8Array;
  filename: string;
  collection: string;
  tenant: Tenant;
  title?: string;
  authority?: string;
  license?: string;
}

export interface IngestResult {
  documentId: string;
  deduped: boolean;
  chunkCount: number;
  byKind: Record<string, number>;
  accountRows: number;
  warnings: string[];
  jobId?: string;
}

export function blockText(b: ExtractBlock): string {
  if (b.type === "table") return b.markdown ?? (b.cells ?? []).map((r) => r.join(" | ")).join("\n");
  if (b.type === "account_row") {
    return `${b.code ?? ""} ${b.name_lo ?? ""}${b.name_en ? ` — ${b.name_en}` : ""}`.trim();
  }
  return b.text ?? "";
}

async function setStatus(documentId: string, status: (typeof schema.docStatus.enumValues)[number]): Promise<void> {
  await db()
    .update(schema.ragDocument)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.ragDocument.id, documentId));
}

export async function ingestDocx(input: IngestInput): Promise<IngestResult> {
  const { bytes, filename, collection, tenant } = input;
  const sha = sha256(bytes);

  // 1. sha256 dedupe within (tenant, collection).
  const existing = await db()
    .select({ id: schema.ragDocument.id })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
        eq(schema.ragDocument.collection, collection),
        eq(schema.ragDocument.contentSha256, sha),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return {
      documentId: existing[0].id,
      deduped: true,
      chunkCount: 0,
      byKind: {},
      accountRows: 0,
      warnings: ["duplicate content sha256 — skipped"],
    };
  }

  // 2. store original, insert rag_document.
  const ext = extname(filename) || ".docx";
  const key = originalKey(tenant.hfId, tenant.companyId, collection, sha, ext);
  await put(key, bytes);

  const documentId = newId();
  await db().insert(schema.ragDocument).values({
    id: documentId,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    branchId: tenant.branchId ?? null,
    collection,
    title: input.title ?? filename,
    sourceFilename: filename,
    sourceUri: key,
    lang: "mixed",
    status: "extracting",
    contentSha256: sha,
    authority: input.authority ?? null,
    license: input.license ?? "internal",
    meta: {},
  });

  // 3. extract — .md in-process, .docx via the docx-extractor sidecar.
  let extraction;
  try {
    extraction = await extractFile(bytes, filename);
  } catch (err) {
    await setStatus(documentId, "failed");
    throw err;
  }
  await setStatus(documentId, "extracted");

  // 4. segment each content block (exact token counts for chunking).
  const segBlocks: SegBlock[] = [];
  for (const b of extraction.blocks) {
    if (b.type === "heading") {
      segBlocks.push({
        kind: "heading",
        level: b.level,
        text: b.text ?? "",
        seg: "",
        tokens: 0,
        lang: "lo",
        headingPath: b.heading_path,
      });
      continue;
    }
    const text = blockText(b);
    if (!text.trim()) continue;
    // Segment the CLEANED text — content_seg is the lexical index and token counts drive
    // chunk boundaries; a doubled vowel or a space inside a syllable mis-tokenizes both.
    // The raw `text` still flows to `content` untouched.
    const s = await segment(fixLaoDefects(text));
    const meta: Record<string, unknown> = {};
    if (b.amounts && b.amounts.length) meta.amounts = b.amounts;
    if (b.type === "account_row") {
      meta.account_code = b.code;
      meta.name_en = b.name_en ?? null;
      meta.coa_confidence = b.confidence ?? null;
    }
    segBlocks.push({
      kind: b.type,
      text,
      seg: s.seg_text,
      tokens: s.token_count,
      lang: s.lang,
      headingPath: b.heading_path,
      meta,
    });
  }

  // 5. chunk, normalize, insert (embedding = NULL, review = pending).
  const chunks = chunkBlocks(segBlocks);
  const rows = [];
  for (const c of chunks) {
    const n = await normalize(c.content);
    // content_norm is the dense-embedding input: lao-nlp NFC/ZWSP normalization plus the
    // whitelisted defect fixes. `content` itself is never mutated (CLAUDE.md).
    rows.push({
      id: newId(),
      documentId,
      hfId: tenant.hfId,
      companyId: tenant.companyId,
      branchId: tenant.branchId ?? null,
      collection,
      seq: c.seq,
      kind: c.kind,
      content: c.content,
      contentNorm: fixLaoDefects(n.normalized),
      contentSeg: c.contentSeg,
      headingPath: c.headingPath,
      lang: c.lang,
      tokenCount: c.tokenCount,
      embedding: null,
      review: "pending" as const,
      meta: c.meta,
    });
  }
  if (rows.length) await db().insert(schema.ragChunk).values(rows);

  // 6. chart-of-accounts rows → lao_account (attrs inferred from code, verified=false).
  const accountBlocks = extraction.blocks.filter((b) => b.type === "account_row");
  if (accountBlocks.length) {
    const accountRows = accountBlocks
      .filter((b) => b.code && b.name_lo)
      .map((b) => {
        const attrs = inferAccountAttrs(b.code!);
        return {
          id: newId(),
          hfId: tenant.hfId,
          companyId: tenant.companyId,
          documentId,
          code: b.code!,
          nameLo: b.name_lo!,
          nameEn: b.name_en ?? null,
          parentCode: null,
          accountClass: attrs.accountClass,
          normalBalance: attrs.normalBalance,
          statement: attrs.statement,
          verified: false,
          meta: { coa_confidence: b.confidence ?? null, inferred: true },
        };
      });
    if (accountRows.length) {
      await db().insert(schema.laoAccount).values(accountRows).onConflictDoNothing();
    }
  }

  await setStatus(documentId, "chunked");

  // 7. enqueue the embed job (resumable; the worker fills embeddings via SKIP LOCKED).
  const jobId = newId();
  await db().insert(schema.ingestJob).values({
    id: jobId,
    hfId: tenant.hfId,
    companyId: tenant.companyId,
    documentId,
    kind: "embed",
    status: "queued",
    payload: {},
  });

  // 8. audit event (outbox — no broker consumes it; decision B).
  await db().insert(schema.outboxEvent).values({
    id: newId(),
    hfId: tenant.hfId,
    aggregateType: "rag_document",
    aggregateId: documentId,
    eventType: "document.chunked",
    payload: { chunkCount: rows.length },
  });

  const byKind: Record<string, number> = {};
  for (const c of chunks) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;

  return {
    documentId,
    deduped: false,
    chunkCount: rows.length,
    byKind,
    accountRows: accountBlocks.length,
    warnings: extraction.warnings,
    jobId,
  };
}
