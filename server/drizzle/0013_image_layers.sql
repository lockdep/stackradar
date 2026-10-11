CREATE TABLE "image_layers" (
	"image_id" uuid NOT NULL,
	"index" smallint NOT NULL,
	"rootfs_index" smallint,
	"diff_id" varchar(128),
	"created_by" text,
	"empty_layer" boolean DEFAULT false NOT NULL,
	"size" bigint,
	"built_at" timestamp with time zone,
	"source" varchar(16) DEFAULT 'scanner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_layers_image_id_index_pk" PRIMARY KEY("image_id","index")
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "layers_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "layer_index" smallint;--> statement-breakpoint
ALTER TABLE "image_layers" ADD CONSTRAINT "image_layers_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_layers_diff_id_idx" ON "image_layers" USING btree ("diff_id");