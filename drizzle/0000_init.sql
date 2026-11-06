CREATE SEQUENCE "public"."run_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"description" text NOT NULL,
	"initials" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text NOT NULL,
	"tools" jsonb NOT NULL,
	"builtins" jsonb NOT NULL,
	"memory_scope" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug"),
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" in ('idle', 'running', 'waiting', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "memory" (
	"id" text PRIMARY KEY NOT NULL,
	"ns" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"data" jsonb,
	"confidence" double precision NOT NULL,
	"source" text NOT NULL,
	"written_by" text NOT NULL,
	"read_by" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"history" jsonb NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', "key"), 'A') || setweight(to_tsvector('english', "value"), 'B')) STORED,
	CONSTRAINT "memory_confidence_check" CHECK ("memory"."confidence" >= 0 and "memory"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "memory_namespaces" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"run_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"step_id" text,
	"agent_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"payload" jsonb,
	CONSTRAINT "run_events_seq_unique" UNIQUE("seq"),
	CONSTRAINT "run_events_kind_check" CHECK ("run_events"."kind" in ('plan', 'message', 'tool_call', 'tool_result', 'memory_write', 'error', 'done'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"display_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"plan" jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"usage" jsonb NOT NULL,
	"output" jsonb,
	"parent_run_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_displayId_unique" UNIQUE("display_id"),
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'settings' NOT NULL,
	"workspace_name" text NOT NULL,
	"region" text NOT NULL,
	"spend_cap_usd" double precision NOT NULL,
	"models" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 'settings')
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"glyph" text NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"auth" jsonb NOT NULL,
	"status" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"granted_agents" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tools_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tools_status_check" CHECK ("tools"."status" in ('connected', 'needs_auth', 'error'))
);
--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_ns_memory_namespaces_id_fk" FOREIGN KEY ("ns") REFERENCES "public"."memory_namespaces"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_ns_key_idx" ON "memory" USING btree ("ns","key");--> statement-breakpoint
CREATE INDEX "memory_search_idx" ON "memory" USING gin ("search");--> statement-breakpoint
CREATE INDEX "memory_expires_at_idx" ON "memory" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_created_at_idx" ON "runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_status_created_at_idx" ON "runs" USING btree ("status","created_at" DESC NULLS LAST);