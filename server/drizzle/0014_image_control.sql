CREATE TABLE "image_control_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"registry" varchar(255),
	"repository" varchar(512) NOT NULL,
	"control" varchar(16) NOT NULL,
	"created_by" uuid,
	"created_by_email" varchar(320),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "control" varchar(16) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "control_detected_by" varchar(24);--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "control_detail" varchar(255);--> statement-breakpoint
ALTER TABLE "image_control_rules" ADD CONSTRAINT "image_control_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_control_rules_org_registry_repository_unique" ON "image_control_rules" USING btree ("org_id",coalesce("registry", ''),"repository");--> statement-breakpoint
CREATE INDEX "images_org_id_control_idx" ON "images" USING btree ("org_id","control");