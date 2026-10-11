ALTER TABLE "api_keys" ADD COLUMN "key_ciphertext" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_revealed_at" timestamp with time zone;