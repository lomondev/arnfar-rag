import { Elysia, t } from "elysia";

import { devTenant } from "../../lib/tenant.ts";
import { citedQaCount, deleteDocument } from "../ingest/clean-corpus.ts";
import {
  createEntry,
  createKind,
  deleteAllEntries,
  deleteKind,
  listEntries,
  listKinds,
  updateEntry,
} from "./service.ts";

const KEY = t.String({ minLength: 1, maxLength: 60, pattern: "^[a-z0-9][a-z0-9-]*$" });

export const knowledgeRoutes = new Elysia({ prefix: "/knowledge" })
  /* ── kinds ── */
  .get("/kinds", async () => listKinds(devTenant()))
  .post(
    "/kinds",
    async ({ body, set }) => {
      const res = await createKind(devTenant(), body);
      if (!res) {
        set.status = 409;
        return { error: `kind '${body.key}' already exists` };
      }
      set.status = 201;
      return res;
    },
    {
      body: t.Object({
        key: KEY,
        nameLo: t.String({ minLength: 1 }),
        nameEn: t.Optional(t.String()),
        description: t.Optional(t.String()),
        collection: t.Optional(t.String({ minLength: 1 })),
      }),
    },
  )
  // ?withEntries=1 also deletes every entry document ("delete all data");
  // blocked with 409 when entries are cited by QA pairs unless ?force=1.
  .delete(
    "/kinds/:id",
    async ({ params, query, set }) => {
      const res = await deleteKind(devTenant(), params.id, {
        withEntries: query.withEntries === "1",
        force: query.force === "1",
      });
      if (!res) {
        set.status = 404;
        return { error: "kind not found" };
      }
      if ("blocked" in res) {
        set.status = 409;
        return { error: `${res.citedQa} QA pair(s) cite entries of this kind`, citedQa: res.citedQa };
      }
      return { ...res, deleted: true };
    },
    { query: t.Object({ withEntries: t.Optional(t.String()), force: t.Optional(t.String()) }) },
  )
  // Bulk: delete ALL entries of a kind, keep the kind. Same cited-QA guard.
  .delete(
    "/entries",
    async ({ query, set }) => {
      const res = await deleteAllEntries(devTenant(), query.kind, query.force === "1");
      if ("blocked" in res) {
        set.status = 409;
        return { error: `${res.citedQa} QA pair(s) cite entries of this kind`, citedQa: res.citedQa };
      }
      return res;
    },
    { query: t.Object({ kind: KEY, force: t.Optional(t.String()) }) },
  )
  /* ── entries ── */
  .get(
    "/entries",
    async ({ query }) => listEntries(devTenant(), query.kind),
    { query: t.Object({ kind: KEY }) },
  )
  .post(
    "/entries",
    async ({ body, set }) => {
      try {
        set.status = 201;
        return await createEntry(devTenant(), body);
      } catch (err) {
        set.status = 422;
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      body: t.Object({
        kindKey: KEY,
        title: t.String({ minLength: 1, maxLength: 300 }),
        body: t.String({ minLength: 1 }),
        authority: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    "/entries/:id",
    async ({ params, body, set }) => {
      const res = await updateEntry(devTenant(), params.id, body);
      if (!res) {
        set.status = 404;
        return { error: "entry not found" };
      }
      return res;
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 300 }),
        body: t.String({ minLength: 1 }),
      }),
    },
  )
  // Same cited-QA guard as document delete — an entry a QA pair cites shouldn't
  // vanish silently.
  .delete(
    "/entries/:id",
    async ({ params, query, set }) => {
      const tenant = devTenant();
      const cited = await citedQaCount(tenant, params.id);
      if (cited > 0 && query.force !== "1") {
        set.status = 409;
        return { error: `${cited} QA pair(s) cite this entry`, citedQa: cited };
      }
      const res = await deleteDocument(tenant, params.id);
      if (!res) {
        set.status = 404;
        return { error: "entry not found" };
      }
      return { ...res, citedQa: cited };
    },
    { query: t.Object({ force: t.Optional(t.String()) }) },
  );
