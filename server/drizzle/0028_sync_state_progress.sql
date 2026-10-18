-- What the app shell's "vulnerability database is being built" banner reads on a fresh install
-- (`GET /api/vulnerabilities/mirror`): where the running OSV bootstrap is, and whether the EPSS
-- and KEV syncs are running right now rather than merely not finished. All three are transient —
-- written during a run, null outside one — so every existing row is correctly null. Additive and
-- safe on a populated database.
ALTER TABLE "osv_sync_state" ADD COLUMN "bootstrap_progress" jsonb;--> statement-breakpoint
ALTER TABLE "epss_sync_state" ADD COLUMN "run_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kev_sync_state" ADD COLUMN "run_started_at" timestamp with time zone;
