ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "pause_after" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled'));