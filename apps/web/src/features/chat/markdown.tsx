/**
 * A small Markdown renderer for assistant answers, with `[n]` citation markers rendered as
 * clickable chips.
 *
 * Deliberately not `react-markdown`: citations have to survive *inside* inline text
 * (bold, list items, table cells), which means the citation pass and the inline pass must
 * be the same pass. Bolting a custom text renderer onto a general Markdown AST to achieve
 * that costs more code than the subset the generator actually emits — headings, lists,
 * fenced code, pipe tables, bold/italic/code, and paragraphs. It also keeps the offline
 * dependency surface at zero.
 *
 * Anything unrecognised falls through as literal text, never as an exception.
 */

import type { JSX, ReactNode } from "react";

export type CiteHandler = (n: number) => void;

/** `code` | **bold** | *italic* | [n] — one alternation so a citation inside bold still resolves. */
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[\d+\])/g;

function renderInline(text: string, onCite: CiteHandler, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part === "") return null;

    const cite = /^\[(\d+)\]$/.exec(part);
    if (cite) {
      const n = Number(cite[1]);
      return (
        <button
          key={key}
          type="button"
          onClick={() => onCite(n)}
          title="View source"
          className="mx-0.5 inline-flex h-[1.15em] min-w-[1.15em] translate-y-[-0.15em] items-center justify-center rounded-[0.3em] bg-citation/12 px-[0.3em] align-middle text-[0.72em] font-semibold text-citation transition-colors hover:bg-citation/25"
        >
          {n}
        </button>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

/** `| a | b |` — a table row. Cells are trimmed; the leading/trailing pipes are optional. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableRow = (l: string): boolean => /\|/.test(l) && l.trim().startsWith("|");
const isTableDivider = (l: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

export function renderMarkdown(text: string, onCite: CiteHandler): ReactNode {
  const lines = text.split("\n");
  const blocks: JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const key = `b${i}`;

    // Fenced code — consumed verbatim, so Lao inside a fence is never re-parsed.
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre
          key={key}
          className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 text-[0.85em] leading-relaxed"
        >
          <code className="font-mono">{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const content = renderInline(heading[2] ?? "", onCite, key);
      const size = level === 1 ? "text-lg" : level === 2 ? "text-base" : "text-[0.95rem]";
      blocks.push(
        <p key={key} lang="lo" className={`mt-4 mb-2 font-semibold first:mt-0 ${size}`} role="heading" aria-level={level}>
          {content}
        </p>,
      );
      i++;
      continue;
    }

    // Pipe table. Accounting answers lean on these (account rows, rate schedules), and a
    // table flattened into prose is unreadable — so it gets real <table> semantics.
    if (isTableRow(line) && isTableDivider(lines[i + 1] ?? "")) {
      const header = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push(tableCells(lines[i] ?? ""));
        i++;
      }
      blocks.push(
        <div key={key} className="my-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-[0.9em]">
            <thead className="bg-muted/60">
              <tr>
                {header.map((h, c) => (
                  <th key={c} lang="lo" className="border-b border-border px-3 py-2 text-left font-semibold">
                    {renderInline(h, onCite, `${key}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} lang="lo" className="px-3 py-2 align-top">
                      {renderInline(cell, onCite, `${key}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lists — a run of consecutive bullets or numbers.
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(l) : /^\s*[-*•]\s+(.*)$/.exec(l);
        if (!m) break;
        items.push(m[1] ?? "");
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={key}
          className={`my-3 space-y-1.5 ps-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}
        >
          {items.map((item, n) => (
            <li key={n} lang="lo" className="leading-[1.75] ps-1">
              {renderInline(item, onCite, `${key}-${n}`)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <blockquote key={key} lang="lo" className="my-3 border-s-2 border-border ps-4 text-muted-foreground italic">
          {renderInline(quote[1] ?? "", onCite, key)}
        </blockquote>,
      );
      i++;
      continue;
    }

    // Paragraph — soft-wrapped lines up to the next blank line or block opener.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        l.trim() === "" ||
        /^(#{1,4})\s/.test(l) ||
        /^\s*[-*•]\s/.test(l) ||
        /^\s*\d+[.)]\s/.test(l) ||
        /^>\s?/.test(l) ||
        l.trimStart().startsWith("```") ||
        isTableRow(l)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    blocks.push(
      <p key={key} lang="lo" className="my-3 leading-[1.8] first:mt-0 last:mb-0">
        {renderInline(para.join("\n"), onCite, key)}
      </p>,
    );
  }

  return blocks;
}
