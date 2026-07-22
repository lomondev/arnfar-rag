import { extractDocx, segment, type ExtractBlock } from "../../lib/sidecars.ts";
import { chunkBlocks, type SegBlock } from "./chunker.ts";
import { blockText } from "./pipeline.ts";
import { fixLaoDefects, scanLaoDefects, type LaoDefects } from "../lao/clean.ts";

/** Dry-run of the ingest pipeline: extract → clean → chunk, NO database writes.
 *  Powers the workbench's Clean and Chunk stages so a curator sees exactly what
 *  would land — defects, boundaries, kinds, token counts — before committing. */

export interface ChunkPreview {
  seq: number;
  kind: string;
  tokenCount: number;
  headingPath: string[];
  /** First 240 chars of the pristine content (what would be stored). */
  excerpt: string;
  defects: LaoDefects | null;
  /** Cleaned excerpt, only when the excerpt itself changes — for the diff view. */
  cleanedExcerpt: string | null;
}

export interface PreviewResult {
  filename: string;
  blocks: number;
  chunks: ChunkPreview[];
  byKind: Record<string, number>;
  totalTokens: number;
  accountRows: number;
  defectTotals: { zeroWidth: number; doubledMarks: number; spaceBeforeMark: number; affectedChunks: number };
  warnings: string[];
}

export async function previewDocx(bytes: Uint8Array, filename: string): Promise<PreviewResult> {
  const extraction = await extractDocx(bytes, filename);

  // Mirror the pipeline's segmentation stage (cleaned text drives seg/token counts).
  const segBlocks: SegBlock[] = [];
  for (const b of extraction.blocks as ExtractBlock[]) {
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
    const s = await segment(fixLaoDefects(text));
    segBlocks.push({
      kind: b.type,
      text,
      seg: s.seg_text,
      tokens: s.token_count,
      lang: s.lang,
      headingPath: b.heading_path,
      meta: {},
    });
  }

  const chunks = chunkBlocks(segBlocks);

  const previews: ChunkPreview[] = [];
  const byKind: Record<string, number> = {};
  const totals = { zeroWidth: 0, doubledMarks: 0, spaceBeforeMark: 0, affectedChunks: 0 };
  let totalTokens = 0;

  for (const c of chunks) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    totalTokens += c.tokenCount;
    const defects = scanLaoDefects(c.content);
    const affected = defects.total > 0;
    if (affected) {
      totals.zeroWidth += defects.zeroWidth;
      totals.doubledMarks += defects.doubledMarks;
      totals.spaceBeforeMark += defects.spaceBeforeMark;
      totals.affectedChunks += 1;
    }
    const excerpt = c.content.slice(0, 240);
    const cleaned = fixLaoDefects(excerpt);
    previews.push({
      seq: c.seq,
      kind: c.kind,
      tokenCount: c.tokenCount,
      headingPath: c.headingPath,
      excerpt,
      defects: affected ? defects : null,
      cleanedExcerpt: affected && cleaned !== excerpt ? cleaned : null,
    });
  }

  return {
    filename,
    blocks: extraction.blocks.length,
    chunks: previews,
    byKind,
    totalTokens,
    accountRows: extraction.blocks.filter((b: ExtractBlock) => b.type === "account_row").length,
    defectTotals: totals,
    warnings: extraction.warnings,
  };
}
