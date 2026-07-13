/** Block stream → retrieval chunks.
 *
 *  Rules (PROMPT.md §3):
 *   - prose/list blocks merge up to maxTokens, with overlapTokens carried over,
 *     and NEVER across a heading boundary (heading_path change or a Heading-1).
 *   - table blocks are ATOMIC — never split; a table over maxTokens is emitted whole.
 *   - account_row blocks become their own chunk (kind='account_row').
 *   - every chunk inherits its blocks' heading_path — this is what makes citations
 *     legible.
 *
 *  Blocks are pre-segmented (content_seg + token_count) so grouping uses exact
 *  counts; a merged chunk's content_seg is the join of its blocks' seg text.
 */

export type BlockKind = "heading" | "prose" | "list" | "table" | "account_row";

export interface SegBlock {
  kind: BlockKind;
  level?: number; // for headings
  text: string;
  seg: string;
  tokens: number;
  lang: string;
  headingPath: string[];
  meta?: Record<string, unknown>;
}

export interface Chunk {
  seq: number;
  kind: Exclude<BlockKind, "heading">;
  content: string;
  contentSeg: string;
  tokenCount: number;
  lang: string;
  headingPath: string[];
  meta: Record<string, unknown>;
}

const samePath = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function chunkBlocks(
  blocks: SegBlock[],
  maxTokens = 400,
  overlapTokens = 60,
): Chunk[] {
  const chunks: Chunk[] = [];
  let acc: SegBlock[] = [];
  let accTokens = 0;
  let seq = 0;

  const emit = (kind: Chunk["kind"], group: SegBlock[]): void => {
    if (group.length === 0) return;
    const first = group[0]!;
    chunks.push({
      seq: seq++,
      kind,
      content: group.map((b) => b.text).join("\n"),
      contentSeg: group.map((b) => b.seg).join(" ").trim(),
      tokenCount: group.reduce((n, b) => n + b.tokens, 0),
      lang: first.lang,
      headingPath: first.headingPath,
      meta: Object.assign({}, ...group.map((b) => b.meta ?? {})),
    });
  };

  const flush = (withOverlap: boolean): void => {
    if (acc.length === 0) return;
    emit("prose", acc);
    if (!withOverlap || overlapTokens <= 0) {
      acc = [];
      accTokens = 0;
      return;
    }
    // Carry trailing blocks summing up to overlapTokens into the next chunk.
    const carry: SegBlock[] = [];
    let t = 0;
    for (let i = acc.length - 1; i > 0 && t < overlapTokens; i--) {
      carry.unshift(acc[i]!);
      t += acc[i]!.tokens;
    }
    acc = carry;
    accTokens = t;
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      flush(false); // heading is a boundary, not content (text lives in heading_path)
      continue;
    }

    if (block.kind === "table" || block.kind === "account_row") {
      flush(false); // flush text accumulator; atomic block gets its own chunk
      emit(block.kind, [block]); // whole, even if over maxTokens
      continue;
    }

    // prose | list
    if (acc.length > 0 && !samePath(acc[0]!.headingPath, block.headingPath)) {
      flush(false); // do not merge across a heading context change
    }
    if (accTokens + block.tokens > maxTokens && acc.length > 0) {
      flush(true); // size flush keeps overlap within the same heading
    }
    acc.push(block);
    accTokens += block.tokens;
  }
  flush(false);

  return chunks;
}
