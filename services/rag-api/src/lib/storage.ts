import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { env } from "./env.ts";
import { repoRoot } from "./paths.ts";

/** Object storage — filesystem driver (CLAUDE.md decision D). Originals are keyed
 *  by content sha256 so identical bytes dedupe to one object. Swap this module for
 *  an S3/MinIO driver later without touching callers. */

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Storage key for an original document, namespaced by tenant + collection. */
export function originalKey(
  hfId: string,
  companyId: string,
  collection: string,
  sha: string,
  ext: string,
): string {
  return join("originals", hfId, companyId, collection, `${sha}${ext}`);
}

function abs(key: string): string {
  // A relative STORAGE_FS_ROOT ("./storage") anchors on the repo root, not process.cwd()
  // — dev.sh launches rag-api with cwd=services/rag-api, which would scatter originals
  // into services/rag-api/storage/ (same bug class as the dataset-export path).
  const root = isAbsolute(env.storageRoot)
    ? resolve(env.storageRoot)
    : resolve(repoRoot(), env.storageRoot);
  const path = resolve(root, key);
  if (!path.startsWith(root)) throw new Error("storage key escapes root");
  return path;
}

export async function put(key: string, bytes: Uint8Array): Promise<string> {
  const path = abs(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return key;
}

export async function get(key: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(abs(key)));
}
