CREATE TABLE "alert_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel" varchar(10) NOT NULL,
	"user_id" uuid,
	"recipient" varchar(255) NOT NULL,
	"subject" text NOT NULL,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"advisory_count" integer DEFAULT 0 NOT NULL,
	"kind" varchar(10) DEFAULT 'alert' NOT NULL,
	"resend_message_id" varchar(64),
	"status" varchar(20) NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "alert_email_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "alert_slack_webhook_url" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "alert_min_severity" varchar(16) DEFAULT 'critical' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "alert_kev" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "alerts_cursor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_sends" ADD CONSTRAINT "alert_sends_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_sends" ADD CONSTRAINT "alert_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_sends_org_sent_idx" ON "alert_sends" USING btree ("org_id","sent_at");--> statement-breakpoint
CREATE INDEX "alert_sends_user_id_idx" ON "alert_sends" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "alert_sends_resend_message_id_idx" ON "alert_sends" USING btree ("resend_message_id");