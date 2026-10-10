CREATE TABLE "digest_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"week" varchar(10) NOT NULL,
	"resend_message_id" varchar(64),
	"status" varchar(20) NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "weekly_digest_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digest_sends_org_id_idx" ON "digest_sends" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "digest_sends_user_id_idx" ON "digest_sends" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "digest_sends_resend_message_id_idx" ON "digest_sends" USING btree ("resend_message_id");