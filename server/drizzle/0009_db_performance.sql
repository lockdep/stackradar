DROP INDEX "sboms_sha256_idx";--> statement-breakpoint
DROP INDEX "components_purl_idx";--> statement-breakpoint
DROP INDEX "components_sbom_direct_idx";--> statement-breakpoint
DROP INDEX "vulnerabilities_cvss_score_idx";--> statement-breakpoint
DROP INDEX "vulnerabilities_risk_score_idx";--> statement-breakpoint
DROP INDEX "vulnerabilities_aliases_gin_idx";--> statement-breakpoint
DROP INDEX "vulnerabilities_withdrawn_at_idx";--> statement-breakpoint
DROP INDEX "vuln_affected_pkg_match_key_idx";--> statement-breakpoint
DROP INDEX "vuln_affected_pkg_generation_idx";--> statement-breakpoint
ALTER TABLE "vulnerability_affected_packages" ADD COLUMN "release_version" varchar(64);--> statement-breakpoint
CREATE INDEX "vuln_affected_pkg_match_key_release_idx" ON "vulnerability_affected_packages" USING btree ("match_key","release_version") WHERE "vulnerability_affected_packages"."withdrawn" = false;--> statement-breakpoint
-- Hand-added (do not regenerate this file): keep the advisory
-- row narrow. `details`, `references`, `database_specific` and `raw_data`
-- averaged ~3 KB inline per row, so every rollup, count and covering-CVE
-- probe read 3.16 GB of heap to reach `finding_identity` and `risk_score`.
-- Above this target the toaster compresses and then moves the largest
-- attributes out of line, leaving the columns the hot paths read in the
-- main heap. Existing tuples are rewritten only when they are next updated;
-- to shrink the heap now, run `VACUUM (FULL) vulnerabilities` (exclusive
-- lock, ~7 GB rewrite) or pg_repack in a maintenance window.
ALTER TABLE "vulnerabilities" SET (toast_tuple_target = 512);
