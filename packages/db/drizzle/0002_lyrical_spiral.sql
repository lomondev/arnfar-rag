CREATE TABLE "knowledge_kind" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name_lo" text NOT NULL,
	"name_en" text,
	"description" text,
	"collection" text DEFAULT 'sop' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_kind_tenant_key" UNIQUE("hf_id","company_id","key")
);
