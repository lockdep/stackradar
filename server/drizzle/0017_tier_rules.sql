CREATE TABLE "component_tier_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"match_kind" varchar(16) NOT NULL,
	"pattern" text NOT NULL,
	"tier" varchar(16) NOT NULL,
	"created_by" uuid,
	"created_by_email" varchar(320),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_finding_tier" varchar(16) DEFAULT 'application' NOT NULL;--> statement-breakpoint
ALTER TABLE "component_tier_rules" ADD CONSTRAINT "component_tier_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "component_tier_rules_org_kind_pattern_unique" ON "component_tier_rules" USING btree ("org_id","match_kind","pattern");