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

import { useState, type JSX, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

export type CiteHandler = (n: number) => void;

/**
 * One alternation, longest/most-specific first, so a citation inside bold still resolves and
 * a `[label](url)` link is never mistaken for a `[n]` citation.
 * `code` | `[text](url)` | **bold** | ~~strike~~ | *italic* | _italic_ | [n]
 */
const INLINE =
  /(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[\d+\])/g;

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;
const CITE = /^\[(\d+)\]$/;

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

    const cite = CITE.exec(part);
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
const isTableDivider = (l: string): boolean => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
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
    const node: ListNode = { ordered: it.ordered, content: it.content, checked: it.checked, children: [] };
    pos.i++;
    if (pos.i < items.length && items[pos.i]!.indent > indent) {
      node.children = buildLevel(items, pos, items[pos.i]!.indent);
    }
    nodes.push(node);
  }
  return nodes;
}

function renderNodes(nodes: readonly ListNode[], onCite: CiteHandler, keyBase: string): JSX.Element {
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

    // Lists — a run of consecutive items at any indentation, nested by leading whitespace.
    if (LIST_ITEM.test(line)) {
      const items: { indent: number; ordered: boolean; content: string; checked: boolean | null }[] = [];
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
        <blockquote key={key} lang="lo" className="my-3 border-s-2 border-border ps-4 text-muted-foreground italic">
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
    blocks.push(
      <p key={key} lang="lo" className="my-3 leading-[1.8] first:mt-0 last:mb-0">
        {renderInline(para.join("\n"), onCite, key)}
      </p>,
    );
  }

  return blocks;
}
