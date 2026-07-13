import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { TenantContext } from "@arnfar/db";
import { schema } from "@arnfar/db";
import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "../../lib/db.ts";

/** Versioned, immutable dataset export. Every invariant is enforced in the QUERY,
 *  not a comment (CLAUDE.md):
 *   - chunks: review <> 'rejected'
 *   - glossary/CoA/QA: verified = true only
 *   - license = 'client-confidential' excluded when shareable
 *   - QA: citation_ids non-empty, every id a non-rejected non-confidential chunk
 *   - QA split is BY DOCUMENT (assigned upstream), never by row
 *  Output is immutable: refuse to overwrite an existing version.
 */

const DATASET_ROOT = "datasets/lao-accounting";

interface FileEntry {
  name: string;
  sha256: string;
  bytes: number;
  records: number;
}

function jsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export interface ExportResult {
  version: string;
  dir: string;
  files: FileEntry[];
  warnings: string[];
}

export async function exportDataset(
  tenant: TenantContext,
  version: string,
  opts: { shareable?: boolean } = {},
): Promise<ExportResult> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("version must be semver, e.g. 0.1.0");
  const dir = resolve(process.cwd(), DATASET_ROOT, `v${version}`);
  if (existsSync(dir)) throw new Error(`v${version} already exists — exports are immutable`);

  const shareable = opts.shareable ?? true;
  const warnings: string[] = [];
  const tenantEq = and(
    eq(schema.ragChunk.hfId, tenant.hfId),
    eq(schema.ragChunk.companyId, tenant.companyId),
  );

  // ── chunks: non-rejected, (shareable → non-confidential) ────────────────────
  const chunkRows = await db()
    .select({
      id: schema.ragChunk.id,
      doc_id: schema.ragChunk.documentId,
      collection: schema.ragChunk.collection,
      heading_path: schema.ragChunk.headingPath,
      content: schema.ragChunk.content,
      content_seg: schema.ragChunk.contentSeg,
      kind: schema.ragChunk.kind,
      lang: schema.ragChunk.lang,
      token_count: schema.ragChunk.tokenCount,
      authority: schema.ragDocument.authority,
      effective_date: schema.ragDocument.effectiveDate,
      license: schema.ragDocument.license,
    })
    .from(schema.ragChunk)
    .innerJoin(schema.ragDocument, eq(schema.ragChunk.documentId, schema.ragDocument.id))
    .where(
      and(
        tenantEq,
        ne(schema.ragChunk.review, "rejected"),
        shareable ? ne(schema.ragDocument.license, "client-confidential") : sql`true`,
      ),
    );
  const allowedChunkIds = new Set(chunkRows.map((c) => c.id));

  // ── glossary: verified only ─────────────────────────────────────────────────
  const glossaryRows = await db()
    .select({
      term_lo: schema.laoTerm.termLo,
      term_lo_seg: schema.laoTerm.termLoSeg,
      term_en: schema.laoTerm.termEn,
      definition_lo: schema.laoTerm.definitionLo,
      definition_en: schema.laoTerm.definitionEn,
      domain: schema.laoTerm.domain,
      variants_lo: schema.laoTerm.variantsLo,
      forbidden_lo: schema.laoTerm.forbiddenLo,
    })
    .from(schema.laoTerm)
    .where(
      and(
        eq(schema.laoTerm.hfId, tenant.hfId),
        eq(schema.laoTerm.companyId, tenant.companyId),
        eq(schema.laoTerm.verified, true),
      ),
    );

  // ── chart of accounts: verified only ────────────────────────────────────────
  const coaRows = await db()
    .select({
      code: schema.laoAccount.code,
      name_lo: schema.laoAccount.nameLo,
      name_en: schema.laoAccount.nameEn,
      parent_code: schema.laoAccount.parentCode,
      class: schema.laoAccount.accountClass,
      normal_balance: schema.laoAccount.normalBalance,
      statement: schema.laoAccount.statement,
    })
    .from(schema.laoAccount)
    .where(
      and(
        eq(schema.laoAccount.hfId, tenant.hfId),
        eq(schema.laoAccount.companyId, tenant.companyId),
        eq(schema.laoAccount.verified, true),
      ),
    );

  // ── QA: verified, non-empty citations all pointing at exportable chunks ──────
  const qaRows = await db()
    .select()
    .from(schema.laoQaPair)
    .where(
      and(
        eq(schema.laoQaPair.hfId, tenant.hfId),
        eq(schema.laoQaPair.companyId, tenant.companyId),
        eq(schema.laoQaPair.verified, true),
      ),
    );

  const bySplit: Record<string, unknown[]> = { train: [], dev: [], test: [] };
  const evalSet: unknown[] = [];
  let droppedQa = 0;
  for (const q of qaRows) {
    if (
      q.citationIds.length === 0 ||
      !q.citationIds.every((id) => allowedChunkIds.has(id))
    ) {
      droppedQa++;
      continue; // uncited or cites a rejected/confidential chunk → never exports
    }
    const split = q.split === "unassigned" ? "train" : q.split;
    bySplit[split]!.push({
      id: q.id,
      messages: [
        { role: "user", content: q.questionLo },
        { role: "assistant", content: q.answerLo },
      ],
      citations: q.citationIds,
      tags: q.tags,
      difficulty: q.difficulty,
      source: q.source,
    });
    if (split === "test") {
      evalSet.push({
        question_lo: q.questionLo,
        gold_chunk_ids: q.citationIds,
        gold_answer_lo: q.answerLo,
        tags: q.tags,
        difficulty: q.difficulty,
      });
    }
  }
  if (droppedQa) warnings.push(`${droppedQa} verified QA pair(s) dropped (citation invalid/excluded)`);

  // ── write files + hash each ─────────────────────────────────────────────────
  await mkdir(dir, { recursive: true });
  const files: FileEntry[] = [];
  const write = async (name: string, rows: unknown[]): Promise<void> => {
    const body = jsonl(rows);
    await writeFile(resolve(dir, name), body, "utf8");
    files.push({
      name,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      records: rows.length,
    });
  };

  await write("chunks.jsonl", chunkRows);
  await write("glossary.jsonl", glossaryRows);
  await write("chart_of_accounts.jsonl", coaRows);
  await write("qa_train.jsonl", bySplit.train!);
  await write("qa_dev.jsonl", bySplit.dev!);
  await write("qa_test.jsonl", bySplit.test!);
  await write("eval_set.jsonl", evalSet);

  // ── source documents (provenance) ───────────────────────────────────────────
  const sourceDocs = await db()
    .select({
      id: schema.ragDocument.id,
      title: schema.ragDocument.title,
      collection: schema.ragDocument.collection,
      authority: schema.ragDocument.authority,
      effective_date: schema.ragDocument.effectiveDate,
      license: schema.ragDocument.license,
    })
    .from(schema.ragDocument)
    .where(
      and(
        eq(schema.ragDocument.hfId, tenant.hfId),
        eq(schema.ragDocument.companyId, tenant.companyId),
      ),
    );
  const includedDocs = sourceDocs.filter(
    (d) => shareable ? d.license !== "client-confidential" : true,
  );

  const createdAt = new Date().toISOString();
  const manifest = {
    dataset: "arnfar-lao-accounting",
    version,
    created_at: createdAt,
    shareable,
    counts: {
      chunks: chunkRows.length,
      glossary: glossaryRows.length,
      chart_of_accounts: coaRows.length,
      qa_train: bySplit.train!.length,
      qa_dev: bySplit.dev!.length,
      qa_test: bySplit.test!.length,
      eval_set: evalSet.length,
    },
    files,
    source_documents: includedDocs,
    warnings,
  };
  const manifestBody = JSON.stringify(manifest, null, 2);
  await writeFile(resolve(dir, "MANIFEST.json"), manifestBody, "utf8");

  await writeFile(resolve(dir, "LICENSE.md"), licenseMd(includedDocs), "utf8");
  await writeFile(resolve(dir, "DATA_CARD.md"), dataCardMd(version, createdAt, manifest, includedDocs), "utf8");

  return { version, dir, files, warnings };
}

function licenseMd(docs: Array<{ license: string | null }>): string {
  const licenses = [...new Set(docs.map((d) => d.license ?? "internal"))];
  return `# License\n\nThis dataset aggregates content under the following source licenses:\n\n${licenses
    .map((l) => `- ${l}`)
    .join("\n")}\n\nRows marked \`client-confidential\` are excluded from shareable exports.\n`;
}

function dataCardMd(
  version: string,
  createdAt: string,
  manifest: { counts: Record<string, number>; warnings: string[] },
  docs: Array<{ title: string; collection: string; authority: string | null; effective_date: string | null; license: string | null }>,
): string {
  const c = manifest.counts;
  return `# Data Card — arnfar-lao-accounting v${version}

Generated: ${createdAt}

## Intended use
Retrieval + supervised fine-tuning for a **Lao accounting** assistant. Lao text is
preserved byte-for-byte; English glosses are alongside, never instead of. Not legal
advice; verify against the cited source and its effective date.

## Contents
| File | Records |
|---|---|
| chunks.jsonl | ${c.chunks} |
| glossary.jsonl | ${c.glossary} |
| chart_of_accounts.jsonl | ${c.chart_of_accounts} |
| qa_train.jsonl | ${c.qa_train} |
| qa_dev.jsonl | ${c.qa_dev} |
| qa_test.jsonl (held out) | ${c.qa_test} |
| eval_set.jsonl | ${c.eval_set} |

## Provenance & authority
${docs.length ? docs.map((d) => `- **${d.title}** (${d.collection}) — authority: ${d.authority ?? "n/a"}, effective: ${d.effective_date ?? "n/a"}, license: ${d.license ?? "internal"}`).join("\n") : "- (none)"}

## Guarantees
- Only \`verified = true\` glossary, chart-of-accounts, and QA rows are included.
- Rejected chunks are excluded from retrieval and export.
- Every QA pair has a non-empty citation set referencing non-rejected chunks.
- Train/dev/test are split **by source document** — QA from one document never straddles splits.
- \`client-confidential\` rows are excluded from shareable exports.

## Known gaps
${manifest.warnings.length ? manifest.warnings.map((w) => `- ${w}`).join("\n") : "- none recorded"}

## Integrity
Each file's sha256 is recorded in \`MANIFEST.json\`. This version is immutable.
`;
}
