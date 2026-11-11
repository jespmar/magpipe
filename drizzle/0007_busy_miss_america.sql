CREATE TABLE "linear_settings" (
	"id" text PRIMARY KEY DEFAULT 'linear' NOT NULL,
	"key_ref" text,
	"key_hint" text,
	"viewer" text,
	"team" jsonb,
	"label" jsonb,
	"states" jsonb NOT NULL,
	"poll_seconds" integer DEFAULT 60 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check" jsonb,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_settings_single_row" CHECK ("linear_settings"."id" = 'linear')
);
--> statement-breakpoint
CREATE TABLE "tracker_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"identifier" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"run_id" text,
	"stage" text NOT NULL,
	"state_name" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_issues_externalId_unique" UNIQUE("external_id"),
	CONSTRAINT "tracker_issues_stage_check" CHECK ("tracker_issues"."stage" in ('spec_ready', 'approved', 'building', 'merge_question', 'done', 'needs_you', 'other'))
);
--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD CONSTRAINT "tracker_issues_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracker_issues_run_idx" ON "tracker_issues" USING btree ("run_id");