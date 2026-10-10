CREATE INDEX "org_terms_acceptances_accepted_by_user_id_idx" ON "org_terms_acceptances" USING btree ("accepted_by_user_id");--> statement-breakpoint
CREATE INDEX "component_licenses_license_id_idx" ON "component_licenses" USING btree ("license_id");--> statement-breakpoint
CREATE INDEX "vuln_scan_runs_org_id_idx" ON "vulnerability_scan_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "feedback_user_id_idx" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feedback_org_id_idx" ON "feedback" USING btree ("org_id");