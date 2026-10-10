ALTER TABLE "org_metrics_snapshots" ADD COLUMN "breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "cluster_metrics_snapshots" ADD COLUMN "breakdown" jsonb;