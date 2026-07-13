CREATE TYPE "public"."chunk_kind" AS ENUM('prose', 'table', 'account_row', 'journal_entry', 'formula', 'list');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('uploaded', 'extracting', 'extracted', 'chunked', 'embedded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."qa_source" AS ENUM('human', 'llm_draft', 'chat_promoted');--> statement-breakpoint
CREATE TYPE "public"."qa_split" AS ENUM('train', 'dev', 'test', 'unassigned');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('pending', 'accepted', 'edited', 'rejected');--> statement-breakpoint
CREATE TABLE "eval_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"qa_pair_id" uuid NOT NULL,
	"retrieved_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"hit_rank" integer,
	"answer_lo" text,
	"judge_score" smallint,
	"judge_reason" text,
	"latency_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"embed_model" text NOT NULL,
	"gen_model" text NOT NULL,
	"retriever" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recall_at_5" numeric(5, 4),
	"recall_at_10" numeric(5, 4),
	"mrr" numeric(5, 4),
	"faithfulness" numeric(5, 4),
	"p95_latency_ms" integer,
	"n_queries" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid,
	"kind" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lao_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid,
	"code" text NOT NULL,
	"name_lo" text NOT NULL,
	"name_en" text,
	"parent_code" text,
	"account_class" text NOT NULL,
	"normal_balance" text NOT NULL,
	"statement" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lao_account_tenant_code" UNIQUE("hf_id","company_id","code"),
	CONSTRAINT "lao_account_normal_balance_chk" CHECK ("lao_account"."normal_balance" IN ('debit','credit')),
	CONSTRAINT "lao_account_statement_chk" CHECK ("lao_account"."statement" IN ('BS','PL','CF','NONE'))
);
--> statement-breakpoint
CREATE TABLE "lao_qa_pair" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"question_lo" text NOT NULL,
	"question_en" text,
	"answer_lo" text NOT NULL,
	"answer_en" text,
	"reasoning_lo" text,
	"citation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"difficulty" smallint DEFAULT 2 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" "qa_source" NOT NULL,
	"split" "qa_split" DEFAULT 'unassigned' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lao_qa_difficulty_chk" CHECK ("lao_qa_pair"."difficulty" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "lao_term" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"term_lo" text NOT NULL,
	"term_lo_seg" text NOT NULL,
	"term_en" text NOT NULL,
	"definition_lo" text,
	"definition_en" text,
	"domain" text DEFAULT 'accounting' NOT NULL,
	"variants_lo" text[] DEFAULT '{}'::text[] NOT NULL,
	"forbidden_lo" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_chunk_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lao_term_tenant_term_domain" UNIQUE("hf_id","company_id","term_lo","domain")
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rag_chunk" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"collection" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" "chunk_kind" DEFAULT 'prose' NOT NULL,
	"content" text NOT NULL,
	"content_norm" text NOT NULL,
	"content_seg" text NOT NULL,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"page_hint" integer,
	"lang" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" halfvec(1024),
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content_seg)) STORED,
	"review" "review_state" DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_chunk_document_seq" UNIQUE("document_id","seq")
);
--> statement-breakpoint
CREATE TABLE "rag_document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"collection" text NOT NULL,
	"title" text NOT NULL,
	"source_filename" text NOT NULL,
	"source_uri" text NOT NULL,
	"lang" text NOT NULL,
	"status" "doc_status" DEFAULT 'uploaded' NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"authority" text,
	"effective_date" date,
	"superseded_by" uuid,
	"license" text DEFAULT 'internal' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_document_tenant_sha" UNIQUE("hf_id","company_id","collection","content_sha256"),
	CONSTRAINT "rag_document_lang_chk" CHECK ("rag_document"."lang" IN ('lo','en','th','mixed'))
);
--> statement-breakpoint
ALTER TABLE "eval_result" ADD CONSTRAINT "eval_result_run_id_eval_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_result" ADD CONSTRAINT "eval_result_qa_pair_id_lao_qa_pair_id_fk" FOREIGN KEY ("qa_pair_id") REFERENCES "public"."lao_qa_pair"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_job" ADD CONSTRAINT "ingest_job_document_id_rag_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rag_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lao_account" ADD CONSTRAINT "lao_account_document_id_rag_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rag_document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lao_term" ADD CONSTRAINT "lao_term_source_chunk_id_rag_chunk_id_fk" FOREIGN KEY ("source_chunk_id") REFERENCES "public"."rag_chunk"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_chunk" ADD CONSTRAINT "rag_chunk_document_id_rag_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rag_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rag_document" ADD CONSTRAINT "rag_document_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."rag_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_job_claim" ON "ingest_job" USING btree ("run_after") WHERE status IN ('queued','running');--> statement-breakpoint
CREATE INDEX "ingest_job_document" ON "ingest_job" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "lao_account_parent" ON "lao_account" USING btree ("hf_id","company_id","parent_code");--> statement-breakpoint
CREATE INDEX "lao_qa_verified" ON "lao_qa_pair" USING btree ("hf_id","company_id","verified","split");--> statement-breakpoint
CREATE INDEX "lao_qa_tags_gin" ON "lao_qa_pair" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "lao_term_en_trgm" ON "lao_term" USING gin (term_en gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "lao_term_lo_trgm" ON "lao_term" USING gin (term_lo gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "outbox_unpublished" ON "outbox_event" USING btree ("created_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE INDEX "rag_chunk_fts_gin" ON "rag_chunk" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "rag_chunk_tenant" ON "rag_chunk" USING btree ("hf_id","company_id","collection");--> statement-breakpoint
CREATE INDEX "rag_chunk_review" ON "rag_chunk" USING btree ("hf_id","company_id","review") WHERE review = 'pending';--> statement-breakpoint
CREATE INDEX "rag_chunk_meta_gin" ON "rag_chunk" USING gin (meta jsonb_path_ops);