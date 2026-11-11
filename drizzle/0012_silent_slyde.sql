ALTER TABLE "forge_settings" ADD COLUMN "auto_merge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_settings" ADD COLUMN "auto_merge_label" text DEFAULT 'auto-merge' NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_settings" ADD COLUMN "auto_merge_first_pass" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "forge_settings" ADD COLUMN "auto_merge_checks" boolean DEFAULT true NOT NULL;