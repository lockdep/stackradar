ALTER TABLE "clusters" ADD COLUMN "first_inventory_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "wc_history_slot_started_idx" ON "workload_container_history" USING btree ("cluster_id","namespace","workload_name","container_name","started_at");--> statement-breakpoint
-- Hand-extended: backfill from the oldest namespace a cluster has ever
-- reported. Null stays meaning "never reported".
UPDATE "clusters" c SET "first_inventory_at" = (SELECT min(n."first_seen_at") FROM "namespaces" n WHERE n."cluster_id" = c."id");
