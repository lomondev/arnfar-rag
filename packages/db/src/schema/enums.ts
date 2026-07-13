import { pgEnum } from "drizzle-orm/pg-core";

export const docStatus = pgEnum("doc_status", [
  "uploaded",
  "extracting",
  "extracted",
  "chunked",
  "embedded",
  "failed",
]);

export const chunkKind = pgEnum("chunk_kind", [
  "prose",
  "table",
  "account_row",
  "journal_entry",
  "formula",
  "list",
]);

export const reviewState = pgEnum("review_state", [
  "pending",
  "accepted",
  "edited",
  "rejected",
]);

export const qaSource = pgEnum("qa_source", ["human", "llm_draft", "chat_promoted"]);

export const qaSplit = pgEnum("qa_split", ["train", "dev", "test", "unassigned"]);

/** Job queue state — Postgres SKIP LOCKED replaces RabbitMQ (CLAUDE.md decision B). */
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
]);
