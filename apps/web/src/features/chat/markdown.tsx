"use client";

/**
 * A dependency-free Markdown renderer for assistant answers, with `[n]` citation markers
 * rendered as clickable chips.
 *
 * Deliberately not `react-markdown`: citations have to survive *inside* inline text
 * (bold, list items, table cells), which means the citation pass and the inline pass must
 * be the same pass. Bolting a custom text renderer onto a general Markdown AST to achieve
 * that costs more code than the subset the generator actually emits — headings, lists
 * (nested + task), fenced code, pipe tables, blockquotes, horizontal rules, links,
 * bold/italic/strike/code, and paragraphs. It also keeps the offline dependency surface
 * at zero.
 *
 * Anything unrecognised falls through as literal text, never as an exception.
 */

import { cn } from "@arnfar/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { type JSX, type ReactNode, useState } from "react";

/** Called with the number inside a citation marker, or null when the marker carries no
 *  number at all (a bare `[n]`). Resolving that number to a source is the caller's job —
 *  the renderer does not know what the answer retrieved. */
export type CiteHandler = (n: number | null) => void;

/**
 * One alternation, longest/most-specific first, so a citation inside bold still resolves and
 * a `[label](url)` link is never mistaken for a `[n]` citation.
 * `code` | `[text](url)` | **bold** | ~~strike~~ | *italic* | _italic_ | [n]
 */
const INLINE =
  /(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[\d+\]|\[[nN]\]\d*)/g;

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
const CITE = /^\[(\d+)\]$/;

/**
 * The malformed citation the smaller Lao generators actually emit.
 *
 * The prompt asks for "a [n] citation"; gemma-3n-laos copies the `[n]` placeholder verbatim
 * and puts the number it meant to cite *after* the bracket — `[n]411`, `[n]701`. Rendering
 * those as literal text leaves the reader with a citation they cannot open, which is exactly
 * the thing this product refuses to ship. They are chips like any other marker; the caller
 * decides what the trailing number resolves to.
 */
const PLACEHOLDER_CITE = /^\[[nN]\](\d*)$/;

function renderInline(text: string, onCite: CiteHandler, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part === "") return null;

    const link = LINK.exec(part);
    if (link) {
      return (
        <a
          key={key}
          href={link[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {link[1]}
        </a>
      );
    }

    const cite = CITE.exec(part) ?? PLACEHOLDER_CITE.exec(part);
    if (cite) {
      const digits = cite[1] ?? "";
      const n = digits === "" ? null : Number(digits);
      return (
        <button
          key={key}
          type="button"
          onClick={() => onCite(n)}
          title="View source"
          className="mx-0.5 inline-flex h-[1.15em] min-w-[1.15em] translate-y-[-0.15em] items-center justify-center rounded-[0.3em] bg-citation/12 px-[0.3em] align-middle text-[0.72em] font-semibold text-citation transition-colors hover:bg-citation/25"
        >
          {n ?? "?"}
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
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return (
        <del key={key} className="text-muted-foreground">
          {part.slice(2, -2)}
        </del>
      );
    }
    if (part.startsWith("**") === false && part.startsWith("*") && part.endsWith("*")) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith("_") && part.endsWith("_")) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

/** A fenced code block with a language label and a copy button — Claude-style. */
function CodeBlock({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between border-b border-border bg-muted/60 px-3 py-1.5">
        <span className="font-mono text-[0.72rem] text-muted-foreground">{lang || "text"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title="Copy code"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.72rem] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[0.85em] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
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
const isTableDivider = (l: string): boolean =>
  /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

type Align = "start" | "center" | "end";

/** Column alignment from the divider row: `:---` start, `---:` end, `:---:` center. */
function tableAligns(divider: string): (Align | null)[] {
  return tableCells(divider).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "end";
    if (left) return "start";
    return null;
  });
}

/**
 * A cell that is a bare quantity — Western or Lao digits, with the separators an amount
 * carries. Used to right-align and tabular-align numeric columns, which is what makes a
 * column of LAK figures readable at a glance instead of a ragged edge.
 */
const NUMERIC_CELL = /^[+\-(]?[\d\u0ED0-\u0ED9][\d\u0ED0-\u0ED9,.\s'’]*[%)]?$/;
const isNumericCell = (c: string): boolean => c !== "" && NUMERIC_CELL.test(c.trim());

/** True when a column is entirely quantities, so it can be aligned as one. */
function columnIsNumeric(rows: string[][], col: number): boolean {
  const values = rows.map((r) => (r[col] ?? "").trim()).filter((c) => c !== "");
  return values.length > 1 && values.every(isNumericCell);
}

/**
 * Normalise a table body to the header's width.
 *
 * Ragged rows are common in generated and extracted tables. A short row used to silently
 * shift every following cell left; a long one used to have its overflow dropped on the
 * floor. Neither is acceptable for an accounting table — short rows are padded, and extra
 * cells are appended to the last column rather than discarded.
 */
function squareRows(rows: string[][], width: number): string[][] {
  return rows.map((row) => {
    if (row.length === width) return row;
    if (row.length < width) return [...row, ...new Array(width - row.length).fill("")];
    const kept = row.slice(0, width - 1);
    kept.push(row.slice(width - 1).join(" · "));
    return kept;
  });
}

/** Does this text contain a pipe table (a header row followed by a divider)? */
export function hasPipeTable(text: string): boolean {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("|")) continue;
    if (isTableDivider(lines[i + 1] ?? "") && line.trimEnd().endsWith("|")) return true;
  }
  return false;
}
const isHr = (l: string): boolean => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) && !l.includes("|");

const LIST_ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

interface ListNode {
  ordered: boolean;
  content: string;
  checked: boolean | null;
  children: ListNode[];
}

/** Build a nesting tree from flat list items, keyed off leading indentation. */
function buildLevel(
  items: readonly { indent: number; ordered: boolean; content: string; checked: boolean | null }[],
  pos: { i: number },
  indent: number,
): ListNode[] {
  const nodes: ListNode[] = [];
  while (pos.i < items.length && items[pos.i]!.indent >= indent) {
    const it = items[pos.i]!;
    if (it.indent > indent) {
      // Orphan deeper item with no parent at this level — attach to the previous sibling.
      const deeper = buildLevel(items, pos, it.indent);
      if (nodes.length > 0) nodes[nodes.length - 1]!.children.push(...deeper);
      continue;
    }
    const node: ListNode = {
      ordered: it.ordered,
      content: it.content,
      checked: it.checked,
      children: [],
    };
    pos.i++;
    if (pos.i < items.length && items[pos.i]!.indent > indent) {
      node.children = buildLevel(items, pos, items[pos.i]!.indent);
    }
    nodes.push(node);
  }
  return nodes;
}

function renderNodes(
  nodes: readonly ListNode[],
  onCite: CiteHandler,
  keyBase: string,
): JSX.Element {
  const ordered = nodes[0]?.ordered ?? false;
  const ListTag = ordered ? "ol" : "ul";
  return (
    <ListTag
      className={`my-3 space-y-1.5 ps-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-muted-foreground`}
    >
      {nodes.map((node, n) => {
        const key = `${keyBase}-${n}`;
        return (
          <li
            key={key}
            lang="lo"
            className={node.checked !== null ? "-ms-5 list-none ps-0" : "leading-[1.75] ps-1"}
          >
            {node.checked !== null && (
              <input
                type="checkbox"
                checked={node.checked}
                readOnly
                className="me-2 translate-y-[0.1em] accent-primary"
              />
            )}
            {renderInline(node.content, onCite, key)}
            {node.children.length > 0 && renderNodes(node.children, onCite, key)}
          </li>
        );
      })}
    </ListTag>
  );
}

export function renderMarkdown(text: string, onCite: CiteHandler): ReactNode {
  const lines = text.split("\n");
  const blocks: JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const key = `b${i}`;

    // Fenced code — consumed verbatim, so Lao inside a fence is never re-parsed.
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push(<CodeBlock key={key} code={body.join("\n")} lang={lang} />);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule — checked before lists so `---` isn't read as a bullet.
    if (isHr(line)) {
      blocks.push(<hr key={key} className="my-5 border-border" />);
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? "#").length, 6);
      const content = renderInline(heading[2] ?? "", onCite, key);
      const HeadingTag = `h${level}` as keyof JSX.IntrinsicElements;
      const size =
        level === 1
          ? "text-xl"
          : level === 2
            ? "text-lg"
            : level === 3
              ? "text-base"
              : "text-[0.95rem]";
      blocks.push(
        <HeadingTag key={key} lang="lo" className={`mt-5 mb-2 font-semibold first:mt-0 ${size}`}>
          {content}
        </HeadingTag>,
      );
      i++;
      continue;
    }

    // Pipe table. Accounting answers lean on these (account rows, rate schedules), and a
    // table flattened into prose is unreadable — so it gets real <table> semantics.
    // The generator sometimes prefixes the header line with inline text — typically a
    // citation, `[2] | ລຳດັບ | … |` — so accept any line whose pipe-part is followed by a
    // divider, and render the prefix as its own inline paragraph above the table.
    const headerPipeAt =
      isTableDivider(lines[i + 1] ?? "") && line.trimEnd().endsWith("|") ? line.indexOf("|") : -1;
    if (headerPipeAt >= 0 && line.slice(headerPipeAt).split("|").length > 2) {
      const prefix = line.slice(0, headerPipeAt).trim();
      if (prefix) {
        blocks.push(
          <p key={`${key}-pre`} lang="lo" className="my-2 leading-[1.8]">
            {renderInline(prefix, onCite, `${key}-pre`)}
          </p>,
        );
      }
      const header = tableCells(line.slice(headerPipeAt));
      const declared = tableAligns(lines[i + 1] ?? "");
      i += 2;
      const raw: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        raw.push(tableCells(lines[i] ?? ""));
        i++;
      }
      const rows = squareRows(raw, header.length);

      // Explicit markdown alignment wins; otherwise a column of pure quantities is aligned
      // to the end so the digits line up. Everything else reads from the start, which is
      // also what keeps Lao text correct under the document's writing direction.
      const aligns: Align[] = header.map((_, c) =>
        (declared[c] ?? null) !== null
          ? (declared[c] as Align)
          : columnIsNumeric(rows, c)
            ? "end"
            : "start",
      );
      const numericCols = header.map(
        (_, c) => (declared[c] ?? null) === null && columnIsNumeric(rows, c),
      );

      const alignClass = (a: Align): string =>
        a === "end" ? "text-end" : a === "center" ? "text-center" : "text-start";

      blocks.push(
        <figure key={key} className="my-4">
          {/* max-h + sticky header: a 40-row account schedule scrolls inside its own box
           * instead of pushing the rest of the answer off the screen, and the column
           * names stay visible while you scroll. */}
          <div className="border-border max-h-[28rem] overflow-auto rounded-xl border shadow-sm">
            <table className="w-full border-collapse text-[0.88em] leading-[1.6]">
              <thead className="bg-muted/80 supports-[backdrop-filter]:bg-muted/60 sticky top-0 z-10 backdrop-blur">
                <tr>
                  {header.map((h, c) => (
                    <th
                      key={c}
                      lang="lo"
                      scope="col"
                      className={cn(
                        "border-border border-b px-3 py-2.5 font-semibold whitespace-nowrap",
                        alignClass(aligns[c] ?? "start"),
                      )}
                    >
                      {renderInline(h, onCite, `${key}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr
                    key={r}
                    className="border-border hover:bg-muted/40 border-b transition-colors last:border-0 even:bg-muted/20"
                  >
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        lang="lo"
                        className={cn(
                          "px-3 py-2 align-top",
                          alignClass(aligns[c] ?? "start"),
                          // Tabular figures so digits sit in a column, not a ragged edge.
                          numericCols[c] && "font-mono text-[0.95em] tabular-nums",
                        )}
                      >
                        {renderInline(cell, onCite, `${key}-${r}-${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Suppressed while a streamed table still has no body rows — "0 rows" flashing
           * under a header the model is mid-way through writing reads as an error. */}
          {rows.length > 0 && (
            <figcaption className="text-muted-foreground mt-1.5 px-1 text-[0.72rem]">
              {rows.length} {rows.length === 1 ? "row" : "rows"} · {header.length}{" "}
              {header.length === 1 ? "column" : "columns"}
            </figcaption>
          )}
        </figure>,
      );
      continue;
    }

    // Lists — a run of consecutive items at any indentation, nested by leading whitespace.
    if (LIST_ITEM.test(line)) {
      const items: {
        indent: number;
        ordered: boolean;
        content: string;
        checked: boolean | null;
      }[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i] ?? "");
        if (!m) break;
        const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
        const ordered = /\d/.test(m[2] ?? "");
        let content = m[3] ?? "";
        const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
        const checked = task ? (task[1] ?? " ") !== " " : null;
        if (task) content = task[2] ?? "";
        items.push({ indent, ordered, content, checked });
        i++;
      }
      const nodes = buildLevel(items, { i: 0 }, items[0]?.indent ?? 0);
      blocks.push(<div key={key}>{renderNodes(nodes, onCite, key)}</div>);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const m = /^>\s?(.*)$/.exec(lines[i] ?? "");
        if (!m) break;
        quoted.push(m[1] ?? "");
        i++;
      }
      blocks.push(
        <blockquote
          key={key}
          lang="lo"
          className="my-3 border-s-2 border-border ps-4 text-muted-foreground italic"
        >
          {renderInline(quoted.join("\n"), onCite, key)}
        </blockquote>,
      );
      continue;
    }

    // Paragraph — soft-wrapped lines up to the next blank line or block opener.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        l.trim() === "" ||
        /^(#{1,6})\s/.test(l) ||
        LIST_ITEM.test(l) ||
        /^>\s?/.test(l) ||
        isHr(l) ||
        l.trimStart().startsWith("```") ||
        isTableRow(l)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    // GUARANTEED PROGRESS: a table row whose divider line hasn't streamed in yet matches
    // no block branch above AND breaks this loop with `i` unmoved — without consuming it
    // the outer while spins forever and the tab hard-freezes mid-stream. Render the
    // orphan line as plain text; the next flush re-parses it into a real table.
    if (para.length === 0) {
      para.push(lines[i] ?? "");
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
