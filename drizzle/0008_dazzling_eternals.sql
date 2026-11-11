ALTER TABLE "tracker_issues" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "external_parent_id" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "goal" jsonb;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "goals_run_id" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD CONSTRAINT "tracker_issues_parent_id_tracker_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tracker_issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD CONSTRAINT "tracker_issues_goals_run_id_runs_id_fk" FOREIGN KEY ("goals_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracker_issues_parent_idx" ON "tracker_issues" USING btree ("parent_id");