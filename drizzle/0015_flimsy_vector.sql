ALTER TABLE "tracker_issues" ADD COLUMN "build_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "rebuild_note" text;