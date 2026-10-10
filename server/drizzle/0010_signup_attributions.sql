CREATE TABLE "signup_attributions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"click_id" varchar(255),
	"utm_source" varchar(255),
	"utm_medium" varchar(255),
	"utm_campaign" varchar(255),
	"utm_content" varchar(255),
	"utm_term" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signup_event_sent_at" timestamp with time zone,
	"cluster_event_sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD CONSTRAINT "signup_attributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_attributions" ADD CONSTRAINT "signup_attributions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signup_attributions_org_id_idx" ON "signup_attributions" USING btree ("org_id");