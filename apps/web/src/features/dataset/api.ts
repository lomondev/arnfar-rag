const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface Term {
  id: string;
  termLo: string;
  termLoSeg: string;
  termEn: string;
  domain: string;
  variantsLo: string[];
  forbiddenLo: string[];
  verified: boolean;
}

export interface QaPair {
  id: string;
  questionLo: string;
  answerLo: string;
  citationIds: string[];
  tags: string[];
  difficulty: number;
  source: string;
  split: string;
  verified: boolean;
}

export interface ExportResult {
  version: string;
  dir: string;
  files: { name: string; sha256: string; bytes: number; records: number }[];
  warnings: string[];
  error?: string;
}

// glossary
export const fetchTerms = (verified?: boolean): Promise<Term[]> =>
  fetch(`${BASE}/glossary/${verified === undefined ? "" : `?verified=${verified}`}`).then(json<Term[]>);
export const mineGlossary = (body: { minFreq?: number; limit?: number; gloss?: boolean }) =>
  fetch(`${BASE}/glossary/mine`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(json);
export const patchTerm = (id: string, patch: Partial<Term>) =>
  fetch(`${BASE}/glossary/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then(json);
export const verifyTerm = (id: string) =>
  fetch(`${BASE}/glossary/${id}/verify`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }).then(json);

// qa
export const fetchQa = (verified?: boolean): Promise<QaPair[]> =>
  fetch(`${BASE}/qa/${verified === undefined ? "" : `?verified=${verified}`}`).then(json<QaPair[]>);
export const verifyQa = (id: string) =>
  fetch(`${BASE}/qa/${id}/verify`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }).then(json);
export const assignSplits = (): Promise<{ train: number; dev: number; test: number }> =>
  fetch(`${BASE}/qa/assign-splits`, { method: "POST" }).then(json<{ train: number; dev: number; test: number }>);

// export
export const runExport = (version: string, shareable: boolean): Promise<ExportResult> =>
  fetch(`${BASE}/export/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, shareable }) }).then(async (r) => (await r.json()) as ExportResult);
