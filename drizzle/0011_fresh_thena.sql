CREATE TABLE "forge_settings" (
	"id" text PRIMARY KEY DEFAULT 'github' NOT NULL,
	"key_ref" text,
	"key_hint" text,
	"viewer" text,
	"repo" text,
	"merge_method" text DEFAULT 'squash' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_settings_single_row" CHECK ("forge_settings"."id" = 'github')
);
--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "merge_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "merge_requested_via" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "land_run_id" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "operator_note" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD CONSTRAINT "tracker_issues_land_run_id_runs_id_fk" FOREIGN KEY ("land_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;