#!/usr/bin/env bun
/**
 * Guard against loading half-finished knowledge templates.
 *
 *   bun run scripts/check-templates.ts
 *
 * The files under `templates/**​/knowledge/` are ready-to-fill scaffolds: a deployer
 * copies one, supplies their own Lao content and — critically — their own `authority`
 * citation. An uncited or fabricated accounting authority is a liability (CLAUDE.md), so
 * this check fails loudly if a document still carries an unfilled marker, keeping a
 * half-finished skeleton from being ingested by mistake.
 *
 * It therefore scans AUTHORED documents, not the scaffolds themselves. `templates/` ships
 * deliberately blank — scanning it could only ever fail, which is why this check reported
 * 36 findings against `_TEMPLATE.md` the first time it was wired into CI. Pass paths as
 * arguments to check your own corpus before ingesting it:
 *
 *   bun run scripts/check-templates.ts docs/knowledge
 *
 * Flags, per file:
 *   • ⟨…⟩            an unfilled blank
 *   • draft skeleton the "not finished yet" note line
 *   • authority:     empty ("") or still literal TODO
 *
 * Exit 0 = every template is finished. Exit 1 = at least one is not (details printed).
 */

import { relative, resolve } from "node:path";

import { Glob } from "bun";

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

const ROOT = new URL("..", import.meta.url).pathname;

/** Authored corpora, scanned by default. `templates/` is excluded on purpose — see above. */
const DEFAULT_GLOBS = ["seed/**/knowledge/*.md"] as const;

const targets = process.argv.slice(2);

/** Absolute paths of every .md to inspect, deduplicated and ordered. */
async function collect(): Promise<string[]> {
  const found = new Set<string>();
  const scan = async (base: string, pattern: string): Promise<void> => {
    for await (const rel of new Glob(pattern).scan({ cwd: base })) {
      // templates/ ships deliberately blank; scanning it could only ever fail.
      if (rel.startsWith("templates/")) continue;
      found.add(resolve(base, rel));
    }
  };
  if (targets.length === 0) {
    for (const pattern of DEFAULT_GLOBS) await scan(ROOT, pattern);
  } else {
    // Directories given on the command line are resolved against the caller's cwd, so
    // `bun run check:templates ../client-corpus` works from anywhere.
    for (const t of targets) await scan(resolve(process.cwd(), t), "**/*.md");
  }
  return [...found].sort();
}

const findings: Finding[] = [];
let scanned = 0;

for (const file of await collect()) {
  const rel = relative(ROOT, file);
  scanned++;
  const text = await Bun.file(file).text();
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    const n = i + 1;
    const push = (reason: string): void => {
      findings.push({ file: rel, line: n, reason, text: line.trim() });
    };

    if (line.includes("⟨")) push("unfilled blank ⟨…⟩");
    if (/draft skeleton/i.test(line)) push("unfinished 'draft skeleton' note");

    const authority = /^\s*authority:\s*(.*)$/.exec(line);
    if (authority) {
      const value = (authority[1] ?? "")
        .replace(/#.*$/, "")
        .trim()
        .replace(/^["']|["']$/g, "");
      if (value === "") push("empty authority — needs a real citation");
      else if (/\bTODO\b/i.test(value)) push("authority still says TODO");
    }
  });
}

if (findings.length === 0) {
  console.log(`✓ ${scanned} knowledge file(s) complete — no unfilled markers`);
  process.exit(0);
}

console.error(`✗ ${findings.length} unfinished marker(s) across ${scanned} knowledge file(s):\n`);
let currentFile = "";
for (const f of findings) {
  if (f.file !== currentFile) {
    console.error(`  ${f.file}`);
    currentFile = f.file;
  }
  console.error(`    ${String(f.line).padStart(4)}  ${f.reason}`);
  console.error(`          › ${f.text}`);
}
console.error(
  `\nFill each blank (and the authority citation) before loading — see templates/accounting/README.md.`,
);
process.exit(1);
