CREATE TABLE "base_image_checks" (
	"registry" varchar(255) NOT NULL,
	"repository" varchar(512) NOT NULL,
	"tag" varchar(255) NOT NULL,
	"current_digest" varchar(128),
	"availability" varchar(24) NOT NULL,
	"newer_tag" varchar(255),
	"newer_digest" varchar(128),
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_image_checks_registry_repository_tag_pk" PRIMARY KEY("registry","repository","tag")
);
