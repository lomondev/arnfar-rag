CREATE TABLE "lesson" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"title_lo" text NOT NULL,
	"title_en" text,
	"summary_lo" text,
	"summary_en" text,
	"difficulty" smallint DEFAULT 2 NOT NULL,
	"estimated_minutes" integer DEFAULT 10 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"prerequisite_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text DEFAULT 'llm_draft' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_difficulty_chk" CHECK ("lesson"."difficulty" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "lesson_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"furthest_seq" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_progress_student_lesson" UNIQUE("student_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE "lesson_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text DEFAULT 'concept' NOT NULL,
	"title_lo" text,
	"title_en" text,
	"body_lo" text,
	"body_en" text,
	"visual" jsonb,
	"qa_pair_id" uuid,
	"citation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_step_seq" UNIQUE("lesson_id","seq"),
	CONSTRAINT "lesson_step_body_chk" CHECK ("lesson_step"."body_lo" IS NOT NULL OR "lesson_step"."body_en" IS NOT NULL),
	CONSTRAINT "lesson_step_citation_chk" CHECK ("lesson_step"."kind" IN ('intro','recap') OR array_length("lesson_step"."citation_ids", 1) >= 1),
	CONSTRAINT "lesson_step_check_chk" CHECK ("lesson_step"."kind" <> 'check' OR "lesson_step"."qa_pair_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "quiz_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"qa_pair_id" uuid NOT NULL,
	"lesson_step_id" uuid,
	"correct" boolean NOT NULL,
	"response" text,
	"elapsed_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"lang" text DEFAULT 'lo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_tenant_name" UNIQUE("hf_id","company_id","display_name")
);
--> statement-breakpoint
CREATE TABLE "subject" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hf_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name_lo" text NOT NULL,
	"name_en" text,
	"description_lo" text,
	"description_en" text,
	"collections" text[] DEFAULT '{}'::text[] NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_tenant_key" UNIQUE("hf_id","company_id","key")
);
--> statement-breakpoint
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subject"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lesson"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_step" ADD CONSTRAINT "lesson_step_lesson_id_lesson_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lesson"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_step" ADD CONSTRAINT "lesson_step_qa_pair_id_lao_qa_pair_id_fk" FOREIGN KEY ("qa_pair_id") REFERENCES "public"."lao_qa_pair"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_qa_pair_id_lao_qa_pair_id_fk" FOREIGN KEY ("qa_pair_id") REFERENCES "public"."lao_qa_pair"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt" ADD CONSTRAINT "quiz_attempt_lesson_step_id_lesson_step_id_fk" FOREIGN KEY ("lesson_step_id") REFERENCES "public"."lesson_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_subject" ON "lesson" USING btree ("hf_id","company_id","subject_id","seq");--> statement-breakpoint
CREATE INDEX "lesson_verified" ON "lesson" USING btree ("hf_id","company_id","verified");--> statement-breakpoint
CREATE INDEX "lesson_progress_student" ON "lesson_progress" USING btree ("hf_id","company_id","student_id");--> statement-breakpoint
CREATE INDEX "lesson_step_lesson" ON "lesson_step" USING btree ("hf_id","company_id","lesson_id","seq");--> statement-breakpoint
CREATE INDEX "quiz_attempt_student" ON "quiz_attempt" USING btree ("hf_id","company_id","student_id","created_at");--> statement-breakpoint
CREATE INDEX "quiz_attempt_pair" ON "quiz_attempt" USING btree ("hf_id","company_id","qa_pair_id");--> statement-breakpoint

-- Tenant isolation for the six tutor tables.
--
-- Added in the SAME migration that creates them, deliberately. Migration 0003 made
-- Postgres — not convention — the thing that keeps tenants apart; a new tenant-scoped
-- table shipped without a policy would quietly reopen exactly the hole 0003 closed, and
-- nothing in the type system or the test suite would notice. The regression guard in
-- packages/db/src/__tests__/rls.test.ts asserts a second tenant cannot see these rows.
DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'subject',
    'lesson',
    'lesson_step',
    'student',
    'lesson_progress',
    'quiz_attempt'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the owning role — the one migrations run as — is subject to it too.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          hf_id      = NULLIF(current_setting('arnfar.hf_id',      true), '')::uuid
          AND company_id = NULLIF(current_setting('arnfar.company_id', true), '')::uuid
        )
        WITH CHECK (
          hf_id      = NULLIF(current_setting('arnfar.hf_id',      true), '')::uuid
          AND company_id = NULLIF(current_setting('arnfar.company_id', true), '')::uuid
        )
    $f$, t);
  END LOOP;
END $$;
