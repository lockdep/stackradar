CREATE TABLE "workload_container_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"workload_id" uuid,
	"namespace" varchar(253) NOT NULL,
	"workload_kind" varchar(63),
	"workload_name" varchar(253) NOT NULL,
	"container_name" varchar(253) NOT NULL,
	"init" boolean DEFAULT false NOT NULL,
	"image_id" uuid,
	"digest" varchar(128) NOT NULL,
	"repository" varchar(512),
	"image_tag" varchar(255),
	"image_ref" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workload_container_history" ADD CONSTRAINT "workload_container_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_container_history" ADD CONSTRAINT "workload_container_history_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_container_history" ADD CONSTRAINT "workload_container_history_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_container_history" ADD CONSTRAINT "wc_history_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wc_history_cluster_started_idx" ON "workload_container_history" USING btree ("cluster_id","started_at");--> statement-breakpoint
CREATE INDEX "wc_history_cluster_ended_idx" ON "workload_container_history" USING btree ("cluster_id","ended_at");--> statement-breakpoint
CREATE INDEX "wc_history_image_id_idx" ON "workload_container_history" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "wc_history_workload_id_idx" ON "workload_container_history" USING btree ("workload_id");--> statement-breakpoint
CREATE INDEX "wc_history_org_ended_idx" ON "workload_container_history" USING btree ("org_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wc_history_open_slot_unique" ON "workload_container_history" USING btree ("cluster_id","namespace","workload_name","container_name","digest") WHERE "workload_container_history"."ended_at" IS NULL;