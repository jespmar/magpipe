ALTER TABLE "forge_settings" ADD COLUMN "key_source" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_settings" ADD COLUMN "key_kind" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_settings" ADD COLUMN "refresh_ref" text;--> statement-breakpoint
ALTER TABLE "linear_settings" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linear_settings" ADD COLUMN "oauth_client_id" text;