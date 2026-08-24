import {
  type Account,
  account,
  type ExportResult,
  exportResult,
  parseResponse,
  type QaInput,
  type QaPair,
  qaPair,
  type SearchHit,
  searchHit,
  type Term,
  term,
} from "@arnfar/contracts";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api";

const BASE = apiBaseUrl();

/**
 * Reads are parsed against the shared contracts, not cast to them.
 *
 * A cast is erased at build time: if rag-api renames a field, both sides still compile
 * and the table quietly renders blanks. Parsing turns that into a named error at the
 * fetch boundary — the endpoint and the field that moved — which is the whole reason
 * @arnfar/contracts exists rather than two hand-maintained copies of these interfaces.
 */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Read path: status check, then contract check. */
async function read<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  endpoint: string,
): Promise<z.infer<S>> {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return parseResponse(schema, await res.json(), endpoint);
}

const JSON_HEADERS = { "content-type": "application/json" };

// glossary
export const fetchTerms = (verified?: boolean): Promise<Term[]> =>
  fetch(`${BASE}/glossary/${verified === undefined ? "" : `?verified=${verified}`}`).then((r) =>
    read(r, z.array(term), "GET /glossary"),
  );
export const mineGlossary = (body: { minFreq?: number; limit?: number; gloss?: boolean }) =>
  fetch(`${BASE}/glossary/mine`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).then(json);
export const createTerm = (body: {
  termLo: string;
  termEn: string;
  definitionLo?: string;
  definitionEn?: string;
  variantsLo?: string[];
  forbiddenLo?: string[];
}) =>
  fetch(`${BASE}/glossary/`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).then(json);
export interface TermPatch {
  termEn?: string;
  definitionLo?: string;
  definitionEn?: string;
  variantsLo?: string[];
  forbiddenLo?: string[];
}
export const patchTerm = (id: string, patch: TermPatch) =>
  fetch(`${BASE}/glossary/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json);
export const verifyTerm = (id: string) =>
  fetch(`${BASE}/glossary/${id}/verify`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  }).then(json);
export const deleteTerm = (id: string) =>
  fetch(`${BASE}/glossary/${id}`, { method: "DELETE" }).then(json);

// qa
export const fetchQa = (verified?: boolean): Promise<QaPair[]> =>
  fetch(`${BASE}/qa/${verified === undefined ? "" : `?verified=${verified}`}`).then((r) =>
    read(r, z.array(qaPair), "GET /qa"),
  );
export const createQa = (body: QaInput) =>
  fetch(`${BASE}/qa/`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).then(
    json,
  );
export const updateQa = (id: string, patch: Partial<QaInput>) =>
  fetch(`${BASE}/qa/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json);
export const deleteQa = (id: string) => fetch(`${BASE}/qa/${id}`, { method: "DELETE" }).then(json);
export const verifyQa = (id: string) =>
  fetch(`${BASE}/qa/${id}/verify`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  }).then(json);
export const assignSplits = (): Promise<{ train: number; dev: number; test: number }> =>
  fetch(`${BASE}/qa/assign-splits`, { method: "POST" }).then(
    json<{ train: number; dev: number; test: number }>,
  );

// accounts (chart of accounts)
export const fetchAccounts = (verified?: boolean): Promise<Account[]> =>
  fetch(`${BASE}/accounts/${verified === undefined ? "" : `?verified=${verified}`}`).then((r) =>
    read(r, z.array(account), "GET /accounts"),
  );
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
  fetch(`${BASE}/accounts/`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).then(json);
export const updateAccount = (id: string, patch: Partial<AccountInput>) =>
  fetch(`${BASE}/accounts/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json);
export const verifyAccount = (id: string) =>
  fetch(`${BASE}/accounts/${id}/verify`, { method: "PATCH" }).then(json);
export const deleteAccount = (id: string) =>
  fetch(`${BASE}/accounts/${id}`, { method: "DELETE" }).then(json);

// search — used as the citation picker when authoring QA pairs
export const searchChunks = (query: string, k = 8): Promise<SearchHit[]> =>
  fetch(`${BASE}/search/`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ query, k }),
  })
    .then((r) => read(r, z.object({ hits: z.array(searchHit) }), "POST /search"))
    .then((r) => r.hits);

// export
export const runExport = (version: string, shareable: boolean): Promise<ExportResult> =>
  fetch(`${BASE}/export/`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ version, shareable }),
  }).then(async (r) => parseResponse(exportResult, await r.json(), "POST /export"));

export type { Account, ExportResult, QaInput, QaPair, SearchHit, Term };
