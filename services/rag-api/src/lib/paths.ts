import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Absolute path to the monorepo root — the directory holding `bun.lock` (workspaces
 *  share a single lockfile, so it exists only at the root) or `.git`.
 *
 *  Anchored on this file's location via `import.meta.dir`, NOT `process.cwd()`, so it is
 *  stable however the process is launched. dev.sh starts rag-api with cwd=services/rag-api
 *  (`bun run --filter`), while `bun run src/index.ts` from the repo root gives cwd=root —
 *  both must resolve to the same place, or cwd-relative writes (e.g. dataset exports) land
 *  in the wrong directory. Memoised. */
let cached: string | undefined;

export function repoRoot(): string {
  if (cached) return cached;
  let dir = import.meta.dir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(resolve(dir, "bun.lock")) || existsSync(resolve(dir, ".git"))) {
      cached = dir;
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root — stop
    dir = parent;
  }
  // Fallback: this file lives at services/rag-api/src/lib, so the root is four levels up.
  cached = resolve(import.meta.dir, "../../../..");
  return cached;
}
