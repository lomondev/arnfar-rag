const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const JSON_HEADERS = { "content-type": "application/json" };

export interface Term {
  id: string;
  termLo: string;
  termLoSeg: string;
  termEn: string;
  definitionLo: string | null;
  definitionEn: string | null;
  domain: string;
  variantsLo: string[];
  forbiddenLo: string[];
  verified: boolean;
}

export interface QaPair {
  id: string;
  questionLo: string;
  answerLo: string;
  questionEn: string | null;
  answerEn: string | null;
  citationIds: string[];
  tags: string[];
  difficulty: number;
  source: string;
  split: string;
  verified: boolean;
}

export interface Account {
  id: string;
  code: string;
  nameLo: string;
  nameEn: string | null;
  parentCode: string | null;
  accountClass: string;
  normalBalance: string;
  statement: string;
  verified: boolean;
}

export interface SearchHit {
  id: string;
  document_id: string;
  content: string;
  heading_path: string[];
  kind: string;
  title: string;
  score: number;
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
  fetch(`${BASE}/glossary/mine`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then(json);
export const createTerm = (body: {
  termLo: string;
  termEn: string;
  definitionLo?: string;
  definitionEn?: string;
  variantsLo?: string[];
  forbiddenLo?: string[];
}) =>
  fetch(`${BASE}/glossary/`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then(json);
export interface TermPatch {
  termEn?: string;
  definitionLo?: string;
  definitionEn?: string;
  variantsLo?: string[];
  forbiddenLo?: string[];
}
export const patchTerm = (id: string, patch: TermPatch) =>
  fetch(`${BASE}/glossary/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) }).then(json);
export const verifyTerm = (id: string) =>
  fetch(`${BASE}/glossary/${id}/verify`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({}) }).then(json);
export const deleteTerm = (id: string) =>
  fetch(`${BASE}/glossary/${id}`, { method: "DELETE" }).then(json);

// qa
export interface QaInput {
  questionLo: string;
  answerLo: string;
  questionEn?: string;
  answerEn?: string;
  citationIds: string[];
  tags?: string[];
  difficulty?: number;
}
export const fetchQa = (verified?: boolean): Promise<QaPair[]> =>
  fetch(`${BASE}/qa/${verified === undefined ? "" : `?verified=${verified}`}`).then(json<QaPair[]>);
export const createQa = (body: QaInput) =>
  fetch(`${BASE}/qa/`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then(json);
export const updateQa = (id: string, patch: Partial<QaInput>) =>
  fetch(`${BASE}/qa/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) }).then(json);
export const deleteQa = (id: string) =>
  fetch(`${BASE}/qa/${id}`, { method: "DELETE" }).then(json);
export const verifyQa = (id: string) =>
  fetch(`${BASE}/qa/${id}/verify`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({}) }).then(json);
export const assignSplits = (): Promise<{ train: number; dev: number; test: number }> =>
  fetch(`${BASE}/qa/assign-splits`, { method: "POST" }).then(json<{ train: number; dev: number; test: number }>);

// accounts (chart of accounts)
export const fetchAccounts = (verified?: boolean): Promise<Account[]> =>
  fetch(`${BASE}/accounts/${verified === undefined ? "" : `?verified=${verified}`}`).then(json<Account[]>);
export interface AccountInput {
  code: string;
  nameLo: string;
  nameEn?: string;
  parentCode?: string;
  accountClass: string;
  normalBalance: string;
  statement: string;
}
export const createAccount = (body: AccountInput) =>
  fetch(`${BASE}/accounts/`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then(json);
export const updateAccount = (id: string, patch: Partial<AccountInput>) =>
  fetch(`${BASE}/accounts/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) }).then(json);
export const verifyAccount = (id: string) =>
  fetch(`${BASE}/accounts/${id}/verify`, { method: "PATCH" }).then(json);
export const deleteAccount = (id: string) =>
  fetch(`${BASE}/accounts/${id}`, { method: "DELETE" }).then(json);

// search — used as the citation picker when authoring QA pairs
export const searchChunks = (query: string, k = 8): Promise<SearchHit[]> =>
  fetch(`${BASE}/search/`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ query, k }) })
    .then(json<{ hits: SearchHit[] }>)
    .then((r) => r.hits);

// export
export const runExport = (version: string, shareable: boolean): Promise<ExportResult> =>
  fetch(`${BASE}/export/`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ version, shareable }) }).then(async (r) => (await r.json()) as ExportResult);
