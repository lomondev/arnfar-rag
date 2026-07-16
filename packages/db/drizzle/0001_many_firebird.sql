CREATE TABLE "rag_conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"title" text NOT NULL,
	"lang" text DEFAULT 'mixed' NOT NULL,
	"collection" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_conversation_lang_chk" CHECK ("rag_conversation"."lang" IN ('lo','en','th','mixed'))
);
--> statement-breakpoint
CREATE TABLE "rag_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"sources" jsonb,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rag_message_role_chk" CHECK ("rag_message"."role" IN ('user','assistant'))
);
--> statement-breakpoint
ALTER TABLE "rag_message" ADD CONSTRAINT "rag_message_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."rag_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rag_conversation_tenant_updated" ON "rag_conversation" USING btree ("hf_id","company_id","updated_at");--> statement-breakpoint
CREATE INDEX "rag_message_conversation_created" ON "rag_message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "rag_message_tenant" ON "rag_message" USING btree ("hf_id","company_id");--> statement-breakpoint
CREATE INDEX "rag_message_meta_gin" ON "rag_message" USING gin (meta jsonb_path_ops);