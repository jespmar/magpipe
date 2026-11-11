CREATE TABLE "factory_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_path" text NOT NULL,
	"scripts" jsonb NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"linear" jsonb NOT NULL,
	"github" jsonb NOT NULL,
	"linear_key_ref" text,
	"linear_key_hint" text,
	"github_key_ref" text,
	"github_key_hint" text,
	"max_runs" integer,
	"spend_cap_usd" double precision,
	"models" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "tracker_issues" ADD CONSTRAINT "tracker_issues_project_id_factory_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."factory_projects"("id") ON DELETE set null ON UPDATE no action;