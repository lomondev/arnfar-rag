import { extractDocx, type ExtractResult } from "../../lib/sidecars.ts";
import { extractMarkdown, isMarkdownFile } from "./markdown.ts";

/** Extension-dispatched extraction. `.md`/`.markdown` parse in-process;
 *  everything else goes to the docx-extractor sidecar. Both produce the same
 *  typed block stream, so the pipeline downstream is format-agnostic. */
export function extractFile(bytes: Uint8Array, filename: string): Promise<ExtractResult> {
  if (isMarkdownFile(filename)) return Promise.resolve(extractMarkdown(bytes));
  return extractDocx(bytes, filename);
}
