CREATE TABLE "known_layer_prefixes" (
	"diff_id_prefix_hash" varchar(64) NOT NULL,
	"depth" smallint NOT NULL,
	"image_ref" text NOT NULL,
	"source" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "known_layer_prefixes_diff_id_prefix_hash_image_ref_pk" PRIMARY KEY("diff_id_prefix_hash","image_ref")
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "base_image_ref" text;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "base_layer_count" smallint;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "base_detected_by" varchar(16);--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "from_base" boolean;--> statement-breakpoint
CREATE INDEX "known_layer_prefixes_image_ref_idx" ON "known_layer_prefixes" USING btree ("image_ref");