ALTER TABLE "components" ADD COLUMN "tier" varchar(16) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "tier_version" smallint DEFAULT 0 NOT NULL;