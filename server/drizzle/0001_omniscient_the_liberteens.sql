ALTER TABLE "images" ADD COLUMN "last_scan_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "last_scan_error_host" varchar(255);--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "last_scan_error_at" timestamp with time zone;