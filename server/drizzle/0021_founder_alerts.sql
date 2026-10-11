ALTER TABLE "signup_attributions" ADD COLUMN "timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD COLUMN "locale" varchar(64);--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD COLUMN "founder_signup_alert_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD COLUMN "founder_cluster_alert_sent_at" timestamp with time zone;