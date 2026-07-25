#!/usr/bin/env bun
/**
 * Guard against loading half-finished knowledge templates.
 *
 *   bun run scripts/check-templates.ts
 *
 * The `templates/**​/knowledge/*.md` files are ready-to-fill scaffolds: a deployer
 * supplies their own Lao content and — critically — their own `authority` citation.
 * An uncited or fabricated accounting authority is a liability (CLAUDE.md), so this
 * check fails loudly if any template still carries an unfilled marker, keeping a
 * skeleton from being saved-as-.docx and ingested by mistake.
 *
 * Flags, per file:
 *   • ⟨…⟩            an unfilled blank
 *   • draft skeleton the "not finished yet" note line
 *   • authority:     empty ("") or still literal TODO
 *
 * Exit 0 = every template is finished. Exit 1 = at least one is not (details printed).
 */

import { Glob } from "bun";

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

const ROOT = new URL("..", import.meta.url).pathname;
const glob = new Glob("templates/**/knowledge/*.md");

const findings: Finding[] = [];
let scanned = 0;

for await (const rel of glob.scan({ cwd: ROOT })) {
  scanned++;
  const text = await Bun.file(`${ROOT}${rel}`).text();
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
      const value = (authority[1] ?? "").replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
      if (value === "") push("empty authority — needs a real citation");
      else if (/\bTODO\b/i.test(value)) push("authority still says TODO");
    }
  });
}

if (findings.length === 0) {
  console.log(`✓ templates complete — ${scanned} knowledge file(s), no unfilled markers`);
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
console.error(`\nFill each blank (and the authority citation) before loading — see templates/accounting/README.md.`);
process.exit(1);
