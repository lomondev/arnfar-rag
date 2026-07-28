import type { ExtractBlock, ExtractResult } from "../../lib/sidecars.ts";

/** Markdown → the same typed block stream the docx-extractor sidecar emits.
 *
 *  Deterministic, line-based CommonMark subset: ATX + setext headings, GFM pipe
 *  tables (atomic, like docx tables), list items, fenced code, blockquotes,
 *  paragraphs. Inline markup (`**bold**`, links) is left verbatim — `content`
 *  stays byte-for-byte original (CLAUDE.md). No account_row detection: markdown
 *  CoA tables land as `table` chunks and can be promoted later.
 */

export function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

// ── amounts — port of docx-extractor/app/amounts.py; keep the two in sync ────
const D = "0-9໐-໙"; // Arabic + Lao digits
const CUR = "(?:ກີບ|LAK|KIP|kip|Kip|₭)";
const AMOUNT = new RegExp(
  `(?:[${D}]+(?:[.,][${D}]+)*\\s*${CUR}|${CUR}\\s*[${D}]+(?:[.,][${D}]+)*|[${D}]{1,3}(?:[.,][${D}]{3})+(?:[.,][${D}]+)?)`,
  "g",
);

function findAmounts(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const lit = m[0].trim();
    if (lit && !seen.has(lit)) {
      seen.add(lit);
      out.push(lit);
    }
  }
  return out;
}

// ── line grammar ─────────────────────────────────────────────────────────────
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SETEXT = /^\s*(=+|-+)\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(\S.*)$/;
const TABLE_SEP_CELL = /^:?-+:?$/;

/** Split a `| a | b |` row into trimmed cells, honouring escaped `\|`. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s
    .replaceAll("\\|", "\u0000")
    .split("|")
    .map((c) => c.replaceAll("\u0000", "|").trim());
}

/** Same semantics as docx-extractor's `_update_stack`. */
function updateStack(stack: string[], level: number, text: string): void {
  stack.splice(level - 1);
  while (stack.length < level - 1) stack.push("");
  stack.push(text);
}

function swapBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length - (b.length % 2));
  for (let i = 0; i + 1 < b.length; i += 2) {
    out[i] = b[i + 1]!;
    out[i + 1] = b[i]!;
  }
  return out;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Decode to text: UTF-8 by default, UTF-16 via BOM or NUL-density heuristic —
 *  Windows Notepad saves Lao text as UTF-16 ("Unicode"), which a blind UTF-8
 *  decode turns into NUL-riddled mojibake that Postgres then rejects.
 *  Throws (→ 422 with a clear message) if the bytes are not decodable text. */
function decodeText(bytes: Uint8Array, warnings: string[]): string {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
    warnings.push("ໄຟລ໌ເປັນ UTF-16LE — ຖອດລະຫັດໃຫ້ແລ້ວ; ແນະນຳບັນທຶກເປັນ UTF-8");
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder("utf-16le").decode(swapBytes(bytes.subarray(2)));
    warnings.push("ໄຟລ໌ເປັນ UTF-16BE — ຖອດລະຫັດໃຫ້ແລ້ວ; ແນະນຳບັນທຶກເປັນ UTF-8");
  } else {
    text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    const nuls = countChar(text, "\u0000");
    if (nuls > 0 && nuls > text.length / 8) {
      // BOM-less UTF-16: try both byte orders, keep the cleaner decode.
      const le = new TextDecoder("utf-16le").decode(bytes);
      const be = new TextDecoder("utf-16le").decode(swapBytes(bytes));
      const bad = (s: string): number => countChar(s, "\uFFFD") + countChar(s, "\u0000");
      text = (bad(le) <= bad(be) ? le : be).replace(/^\uFEFF/, "");
      warnings.push("ໄຟລ໌ເປັນ UTF-16 (ບໍ່ມີ BOM) — ຖອດລະຫັດໃຫ້ແລ້ວ; ແນະນຳບັນທຶກເປັນ UTF-8");
    }
  }
  if (text.includes("\u0000")) {
    text = text.replaceAll("\u0000", "");
    warnings.push("NUL characters removed — file encoding looks damaged, please re-save as UTF-8");
  }
  if (countChar(text, "\uFFFD") > text.length / 20) {
    throw new Error("ໄຟລ໌ບໍ່ແມ່ນ text ທີ່ອ່ານໄດ້ — ບັນທຶກເປັນ UTF-8 (.md) ກ່ອນ / file is not readable text, save it as UTF-8");
  }
  return text;
}

export function extractMarkdown(bytes: Uint8Array): ExtractResult {
  const warnings: string[] = [];
  const raw = decodeText(bytes, warnings);
  const lines = raw.split(/\r\n|\r|\n/);

  const blocks: ExtractBlock[] = [];
  const stack: string[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    const text = para.join("\n").trim();
    para = [];
    if (text) {
      blocks.push({ type: "prose", heading_path: [...stack], text, amounts: findAmounts(text) });
    }
  };

  let i = 0;

  // YAML frontmatter: metadata, not document content.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end > 0) {
      i = end + 1;
      warnings.push(`YAML frontmatter skipped (lines 1–${end + 1})`);
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    // fenced code — verbatim prose, fences stripped (they are markup, not content)
    const fence = line.match(FENCE);
    if (fence) {
      flushPara();
      const mark = fence[1]!;
      const closeRe = new RegExp(`^\\s*[${mark[0]!}]{${mark.length},}\\s*$`);
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (closeRe.test(lines[i]!)) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      if (!closed) warnings.push("unclosed code fence — content kept to end of file");
      const text = body.join("\n").trim();
      if (text) {
        blocks.push({ type: "prose", heading_path: [...stack], text, amounts: findAmounts(text) });
      }
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    // ATX heading
    const h = line.match(HEADING);
    if (h) {
      flushPara();
      const text = h[2]!.trim();
      if (text) {
        const level = h[1]!.length;
        updateStack(stack, level, text);
        blocks.push({ type: "heading", level, text, heading_path: [...stack] });
      }
      i++;
      continue;
    }

    // setext heading: the accumulated paragraph is the heading text
    if (para.length > 0 && SETEXT.test(line)) {
      const level = line.trim().startsWith("=") ? 1 : 2;
      const text = para.join(" ").trim();
      para = [];
      updateStack(stack, level, text);
      blocks.push({ type: "heading", level, text, heading_path: [...stack] });
      i++;
      continue;
    }

    // thematic break
    if (HR.test(line)) {
      flushPara();
      i++;
      continue;
    }

    // GFM table: a run of `|` lines whose second line is the separator row
    if (line.includes("|")) {
      const run: string[] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trim() && lines[j]!.includes("|")) {
        run.push(lines[j]!);
        j++;
      }
      const sep = run.length >= 2 ? splitRow(run[1]!) : [];
      if (sep.length > 0 && sep.every((c) => TABLE_SEP_CELL.test(c))) {
        flushPara();
        const cells = run.filter((_, k) => k !== 1).map(splitRow);
        blocks.push({
          type: "table",
          heading_path: [...stack],
          markdown: run.map((l) => l.trim()).join("\n"),
          cells,
          amounts: findAmounts(cells.flat().join(" ")),
        });
        i = j;
        continue;
      }
      // not a table — fall through as paragraph text
    }

    // list item (+ indented continuation lines)
    const li = line.match(LIST_ITEM);
    if (li) {
      flushPara();
      const indent = li[1]!.replaceAll("\t", "  ").length;
      let text = li[2]!.trim();
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (!l.trim() || !/^\s{2,}/.test(l) || LIST_ITEM.test(l) || HEADING.test(l) || FENCE.test(l)) break;
        text += `\n${l.trim()}`;
        j++;
      }
      blocks.push({
        type: "list",
        heading_path: [...stack],
        text,
        level: Math.floor(indent / 2),
        amounts: findAmounts(text),
      });
      i = j;
      continue;
    }

    // blockquote — strip the marker, keep the text as paragraph content
    if (/^\s*>/.test(line)) {
      para.push(line.replace(/^\s*(?:>\s?)+/, ""));
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();

  const byType: Record<string, number> = {};
  const headingPaths: string[][] = [];
  let nAmounts = 0;
  for (const b of blocks) {
    byType[b.type] = (byType[b.type] ?? 0) + 1;
    nAmounts += b.amounts?.length ?? 0;
    if (b.type === "heading") headingPaths.push(b.heading_path);
  }

  return {
    blocks,
    footnotes: [],
    stats: {
      n_blocks: blocks.length,
      by_type: byType,
      n_amounts: nAmounts,
      n_account_rows: 0,
      heading_paths: headingPaths,
      footnotes: 0,
    },
    warnings,
  };
}
