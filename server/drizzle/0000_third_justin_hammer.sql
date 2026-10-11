CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_by_role" varchar(50) NOT NULL,
	"terms_version" varchar(32) NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"terms_version" varchar(32) NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"color" varchar(50),
	"plan" varchar(50) DEFAULT 'free' NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"stripe_subscription_status" varchar(50),
	"stripe_current_period_end" timestamp with time zone,
	"stripe_cancel_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "org_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"invited_by" uuid,
	"token" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"email_status" varchar(20),
	"email_message_id" varchar(64),
	"email_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"cluster_id" uuid,
	"scopes" text[] DEFAULT ARRAY['sbom:write']::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"scanner_version" varchar(64),
	"scanner_last_seen_at" timestamp with time zone,
	"kubernetes_version" varchar(64),
	"owner_metadata_collected" boolean,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"name" varchar(253) NOT NULL,
	"labels" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helm_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"namespace" varchar(253) NOT NULL,
	"name" varchar(253) NOT NULL,
	"chart_name" varchar(253),
	"chart_version" varchar(128),
	"app_version" varchar(128),
	"repo_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gitops_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"namespace" varchar(253) NOT NULL,
	"name" varchar(253) NOT NULL,
	"tool" varchar(20) NOT NULL,
	"repo_url" text,
	"target_revision" varchar(253),
	"chart" varchar(253),
	"path" text,
	"destination_namespace" varchar(253),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"namespace_id" uuid NOT NULL,
	"kind" varchar(63),
	"name" varchar(253) NOT NULL,
	"release_id" uuid,
	"application_id" uuid,
	"running_pods" integer,
	"labels" jsonb,
	"first_started_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workload_containers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workload_id" uuid NOT NULL,
	"name" varchar(253) NOT NULL,
	"init" boolean DEFAULT false NOT NULL,
	"image_id" uuid NOT NULL,
	"image_ref" text NOT NULL,
	"image_tag" varchar(255),
	"running_pods" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"digest" varchar(128) NOT NULL,
	"registry" varchar(255),
	"repository" varchar(512),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sboms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_id" uuid NOT NULL,
	"format" varchar(20) NOT NULL,
	"sbom_sha256" varchar(64) NOT NULL,
	"serial_number" varchar(255),
	"document_version" integer,
	"spec_version" varchar(10) NOT NULL,
	"source_name" varchar(255),
	"source_type" varchar(50),
	"tool_name" varchar(255),
	"tool_version" varchar(100),
	"scanner_version" varchar(64),
	"generated_at" timestamp with time zone,
	"raw_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"sbom_id" uuid NOT NULL,
	"purl" text,
	"name" text NOT NULL,
	"version" text,
	"type" varchar(50) NOT NULL,
	"group_name" text,
	"publisher" text,
	"author" text,
	"description" text,
	"cpe" text,
	"bom_ref" text,
	"is_direct" boolean DEFAULT false,
	"scope" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_dependencies" (
	"sbom_id" uuid NOT NULL,
	"parent_component_id" uuid NOT NULL,
	"child_component_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comp_dep_pk" PRIMARY KEY("sbom_id","parent_component_id","child_component_id")
);
--> statement-breakpoint
CREATE TABLE "component_hashes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"algorithm" varchar(20) NOT NULL,
	"value" varchar(256) NOT NULL,
	CONSTRAINT "component_hash_alg_unique" UNIQUE("component_id","algorithm")
);
--> statement-breakpoint
CREATE TABLE "component_external_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"url" text NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "component_licenses" (
	"component_id" uuid NOT NULL,
	"license_id" uuid NOT NULL,
	CONSTRAINT "component_licenses_component_id_license_id_pk" PRIMARY KEY("component_id","license_id")
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spdx_id" varchar(100),
	"name" varchar(255),
	"expression" varchar(512),
	CONSTRAINT "licenses_spdx_id_unique" UNIQUE("spdx_id")
);
--> statement-breakpoint
CREATE TABLE "component_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_vulnerabilities" (
	"component_id" uuid NOT NULL,
	"vulnerability_id" uuid NOT NULL,
	"matched_by" varchar(20),
	"match_type" varchar(10),
	"match_confidence" varchar(20),
	"fixed_version" varchar(255),
	"upstream_name" varchar(512),
	"upstream_version" varchar(255),
	"matched_ecosystem" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_vulnerabilities_component_id_vulnerability_id_pk" PRIMARY KEY("component_id","vulnerability_id")
);
--> statement-breakpoint
CREATE TABLE "vulnerabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vuln_id" varchar(100) NOT NULL,
	"id_prefix" varchar(50) GENERATED ALWAYS AS (SPLIT_PART(vuln_id, '-', 1)) STORED,
	"schema_version" varchar(20),
	"source" varchar(50) NOT NULL,
	"source_url" text,
	"summary" varchar(512),
	"details" text,
	"severity" jsonb DEFAULT '[]'::jsonb,
	"severity_level" varchar(20),
	"cvss_score" real,
	"epss_score" real,
	"epss_percentile" real,
	"epss_updated_at" timestamp with time zone,
	"kev_listed_at" timestamp with time zone,
	"kev_due_date" timestamp with time zone,
	"kev_ransomware" varchar(16),
	"risk_score" real GENERATED ALWAYS AS (
    100.0
    * (least(greatest(coalesce(
        cvss_score,
        CASE lower(coalesce(severity_level, ''))
            WHEN 'critical' THEN 9
            WHEN 'high'     THEN 7.5
            WHEN 'medium'   THEN 5
            WHEN 'low'      THEN 2
            ELSE 4
        END
      ), 0), 10) / 10.0)
    * (CASE
        WHEN kev_listed_at IS NOT NULL THEN 1.0
        WHEN epss_score IS NULL THEN 0.1
        ELSE power(least(greatest(epss_score, 0), 1), 1/3.0)
      END)
) STORED,
	"aliases" jsonb DEFAULT '[]'::jsonb,
	"finding_identity" text,
	"related" jsonb DEFAULT '[]'::jsonb,
	"references" jsonb DEFAULT '[]'::jsonb,
	"credits" jsonb DEFAULT '[]'::jsonb,
	"database_specific" jsonb,
	"published_at" timestamp with time zone,
	"modified_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"raw_data" jsonb,
	"raw_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vulnerabilities_vuln_id_unique" UNIQUE("vuln_id")
);
--> statement-breakpoint
CREATE TABLE "vulnerability_affected_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vulnerability_id" uuid NOT NULL,
	"ecosystem" varchar(100),
	"ecosystem_family" varchar(64),
	"ecosystem_release" varchar(128),
	"package_name" varchar(512) NOT NULL,
	"purl" text,
	"match_key" text NOT NULL,
	"withdrawn" boolean DEFAULT false NOT NULL,
	"ranges" jsonb DEFAULT '[]'::jsonb,
	"versions" jsonb DEFAULT '[]'::jsonb,
	"database_specific" jsonb,
	"fixed_version" varchar(255),
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_sync_status" (
	"source" varchar(50) PRIMARY KEY NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"cursor" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"vuln_count" integer DEFAULT 0,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"image_id" uuid,
	"sbom_id" uuid,
	"type" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"title" varchar(255) NOT NULL,
	"triggered_by" varchar(20) DEFAULT 'manual' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"progress" integer DEFAULT 0,
	"progress_message" text,
	"params" jsonb,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('pending', 'scheduled', 'processing', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "vulnerability_scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"sbom_id" uuid,
	"job_id" uuid,
	"trigger" varchar(20) NOT NULL,
	"status" varchar(20) NOT NULL,
	"components_scanned" integer DEFAULT 0 NOT NULL,
	"vulns_found" integer DEFAULT 0 NOT NULL,
	"critical" integer DEFAULT 0 NOT NULL,
	"high" integer DEFAULT 0 NOT NULL,
	"medium" integer DEFAULT 0 NOT NULL,
	"low" integer DEFAULT 0 NOT NULL,
	"osv_mirror_synced_at" timestamp with time zone,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osv_sync_failures" (
	"id" serial PRIMARY KEY NOT NULL,
	"sync_run_id" text NOT NULL,
	"sync_mode" text NOT NULL,
	"osv_id" text,
	"ecosystem_dir" text,
	"source_path" text NOT NULL,
	"error_type" text NOT NULL,
	"error_message" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osv_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"success" boolean NOT NULL,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"affected_packages_extracted" integer DEFAULT 0 NOT NULL,
	"schema_validation_warnings" integer DEFAULT 0 NOT NULL,
	"parse_failures" integer DEFAULT 0 NOT NULL,
	"deduplicated_candidates" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"lag_seconds" real,
	"errors" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osv_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"init_completed_at" timestamp with time zone,
	"last_successful_poll_at" timestamp with time zone,
	"last_modified_seen" timestamp with time zone,
	"last_modified_applied" timestamp with time zone,
	"last_full_refresh_at" timestamp with time zone,
	"sync_status" text DEFAULT 'idle' NOT NULL,
	"affected_pkg_generation" integer DEFAULT 1 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid,
	"type" varchar(50) NOT NULL,
	"image_id" uuid,
	"issue_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"package_type" varchar(50) NOT NULL,
	"package_name" varchar(512) NOT NULL,
	"vuln_identity" varchar(255) NOT NULL,
	"vuln_id" varchar(255) NOT NULL,
	"created_by_user_id" varchar(64) NOT NULL,
	"created_by_email" varchar(255) NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid,
	"scope" varchar(10) NOT NULL,
	"image_id" uuid,
	"release_id" uuid,
	"repository" varchar(512),
	"from_digest" varchar(128),
	"from_tag" varchar(255),
	"to_digest" varchar(128),
	"to_tag" varchar(255),
	"chart_name" varchar(253),
	"from_chart_version" varchar(128),
	"to_chart_version" varchar(128),
	"package_type" varchar(50),
	"package_name" varchar(512),
	"vuln_identity" varchar(255),
	"vuln_id" varchar(255),
	"state" varchar(20) DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" varchar(30),
	"closed_note" text,
	"closed_by_user_id" varchar(64),
	"closed_by_email" varchar(255),
	"created_by_user_id" varchar(64),
	"created_by_email" varchar(255),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_scope_subject_check" CHECK (("issues"."scope" = 'image' AND "issues"."from_digest" IS NOT NULL)
         OR ("issues"."scope" = 'release' AND "issues"."chart_name" IS NOT NULL)
         OR ("issues"."scope" = 'finding' AND "issues"."package_type" IS NOT NULL
             AND "issues"."package_name" IS NOT NULL AND "issues"."vuln_identity" IS NOT NULL)),
	CONSTRAINT "issues_closed_reason_check" CHECK (("issues"."state" = 'closed') = ("issues"."closed_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "chart_repo_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"chart_name" varchar(253) NOT NULL,
	"versions" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"source" varchar(30) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"username" varchar(255),
	"password" text,
	"etag" varchar(255),
	"last_fetched_at" timestamp with time zone,
	"last_fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_hub_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(253) NOT NULL,
	"repo_name" varchar(253) NOT NULL,
	"repo_url" text NOT NULL,
	"description" text,
	"latest_version" varchar(128),
	"stars" integer DEFAULT 0 NOT NULL,
	"repo_official" boolean DEFAULT false NOT NULL,
	"repo_verified" boolean DEFAULT false NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"home_url" text,
	"versions" jsonb NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_hub_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"packages_in_dump" integer,
	"packages_applied" integer,
	"charts_examined" integer,
	"attributions_written" integer,
	"attributions_refused" integer,
	"repos_auto_added" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"chart_name" varchar(253) NOT NULL,
	"package_id" uuid NOT NULL,
	"repo_url" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"matched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_image_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_url" text NOT NULL,
	"chart_name" varchar(253) NOT NULL,
	"chart_version" varchar(128) NOT NULL,
	"image_ref" text NOT NULL,
	"registry" varchar(255) NOT NULL,
	"repository" varchar(512) NOT NULL,
	"tag" varchar(255),
	"digest" varchar(128),
	"resolution_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_url" text NOT NULL,
	"chart_name" varchar(253) NOT NULL,
	"chart_version" varchar(128) NOT NULL,
	"status" varchar(20) NOT NULL,
	"failure_reason" text,
	"helm_version" varchar(64),
	"kube_version" varchar(64),
	"rendered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epss_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_score_date" text,
	"rows_in_file" integer,
	"rows_matched" integer,
	"rows_unmatched" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kev_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"catalog_version" text,
	"released_at" timestamp with time zone,
	"entries_in_catalog" integer,
	"entries_matched" integer,
	"entries_cleared" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_metrics_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_vulnerabilities" integer NOT NULL,
	"total_workloads" integer NOT NULL,
	"total_components" integer NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"critical_vulnerabilities" integer DEFAULT 0 NOT NULL,
	"high_vulnerabilities" integer DEFAULT 0 NOT NULL,
	"medium_vulnerabilities" integer DEFAULT 0 NOT NULL,
	"low_vulnerabilities" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_metrics_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_vulnerabilities" integer NOT NULL,
	"total_workloads" integer NOT NULL,
	"total_components" integer NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"critical_vulnerabilities" integer DEFAULT 0 NOT NULL,
	"high_vulnerabilities" integer DEFAULT 0 NOT NULL,
	"medium_vulnerabilities" integer DEFAULT 0 NOT NULL,
	"low_vulnerabilities" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clusters_id_org_unique" ON "clusters" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_id_org_unique" ON "namespaces" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "helm_releases_id_org_unique" ON "helm_releases" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gitops_applications_id_org_unique" ON "gitops_applications" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workloads_id_org_unique" ON "workloads" USING btree ("id","org_id");--> statement-breakpoint
ALTER TABLE "org_terms_acceptances" ADD CONSTRAINT "org_terms_acceptances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_terms_acceptances" ADD CONSTRAINT "org_terms_acceptances_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helm_releases" ADD CONSTRAINT "helm_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helm_releases" ADD CONSTRAINT "helm_releases_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitops_applications" ADD CONSTRAINT "gitops_applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitops_applications" ADD CONSTRAINT "gitops_applications_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_release_id_helm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."helm_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_application_id_gitops_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."gitops_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_namespace_id_org_id_fk" FOREIGN KEY ("namespace_id","org_id") REFERENCES "public"."namespaces"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_release_id_org_id_fk" FOREIGN KEY ("release_id","org_id") REFERENCES "public"."helm_releases"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_application_id_org_id_fk" FOREIGN KEY ("application_id","org_id") REFERENCES "public"."gitops_applications"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_containers" ADD CONSTRAINT "workload_containers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_containers" ADD CONSTRAINT "workload_containers_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_containers" ADD CONSTRAINT "workload_containers_workload_id_org_id_fk" FOREIGN KEY ("workload_id","org_id") REFERENCES "public"."workloads"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_dependencies" ADD CONSTRAINT "component_dependencies_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_dependencies" ADD CONSTRAINT "component_dependencies_parent_component_id_components_id_fk" FOREIGN KEY ("parent_component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_dependencies" ADD CONSTRAINT "component_dependencies_child_component_id_components_id_fk" FOREIGN KEY ("child_component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_hashes" ADD CONSTRAINT "component_hashes_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_external_refs" ADD CONSTRAINT "component_external_refs_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_licenses" ADD CONSTRAINT "component_licenses_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_licenses" ADD CONSTRAINT "component_licenses_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_properties" ADD CONSTRAINT "component_properties_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_vulnerabilities" ADD CONSTRAINT "comp_vuln_component_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_vulnerabilities" ADD CONSTRAINT "comp_vuln_vuln_fk" FOREIGN KEY ("vulnerability_id") REFERENCES "public"."vulnerabilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_affected_packages" ADD CONSTRAINT "vuln_affected_pkg_vuln_fk" FOREIGN KEY ("vulnerability_id") REFERENCES "public"."vulnerabilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scan_runs" ADD CONSTRAINT "vulnerability_scan_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scan_runs" ADD CONSTRAINT "vulnerability_scan_runs_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scan_runs" ADD CONSTRAINT "vulnerability_scan_runs_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_scan_runs" ADD CONSTRAINT "vulnerability_scan_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_states" ADD CONSTRAINT "finding_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_release_id_helm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."helm_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_cluster_id_org_id_fk" FOREIGN KEY ("cluster_id","org_id") REFERENCES "public"."clusters"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_repo_entries" ADD CONSTRAINT "chart_repo_entries_repository_id_chart_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."chart_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_repositories" ADD CONSTRAINT "chart_repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_attributions" ADD CONSTRAINT "chart_attributions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_attributions" ADD CONSTRAINT "chart_attributions_package_id_artifact_hub_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."artifact_hub_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_metrics_snapshots" ADD CONSTRAINT "org_metrics_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_metrics_snapshots" ADD CONSTRAINT "cluster_metrics_snapshots_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (LOWER("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "org_terms_acceptances_org_version_unique" ON "org_terms_acceptances" USING btree ("org_id","terms_version");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_acceptances_user_version_unique" ON "terms_acceptances" USING btree ("user_id","terms_version");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_active_unique" ON "organizations" USING btree (LOWER("slug")) WHERE "organizations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_members_org_id_idx" ON "org_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_invites_org_id_expires_at_idx" ON "org_invites" USING btree ("org_id","expires_at");--> statement-breakpoint
CREATE INDEX "org_invites_invited_by_idx" ON "org_invites" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX "org_invites_org_email_idx" ON "org_invites" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "org_invites_email_message_id_idx" ON "org_invites" USING btree ("email_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_active_unique" ON "api_keys" USING btree ("key_hash") WHERE "api_keys"."is_active" = true;--> statement-breakpoint
CREATE INDEX "api_keys_key_hash_any_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_cluster_id_idx" ON "api_keys" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "api_keys" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "api_keys_org_id_created_at_idx" ON "api_keys" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clusters_name_org_unique" ON "clusters" USING btree ("name","org_id");--> statement-breakpoint
CREATE INDEX "clusters_org_id_idx" ON "clusters" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "namespaces_cluster_name_unique" ON "namespaces" USING btree ("cluster_id","name");--> statement-breakpoint
CREATE INDEX "namespaces_org_id_idx" ON "namespaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "helm_releases_cluster_namespace_name_unique" ON "helm_releases" USING btree ("cluster_id","namespace","name");--> statement-breakpoint
CREATE INDEX "helm_releases_org_id_idx" ON "helm_releases" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "helm_releases_chart_name_idx" ON "helm_releases" USING btree ("chart_name");--> statement-breakpoint
CREATE UNIQUE INDEX "gitops_applications_cluster_namespace_name_unique" ON "gitops_applications" USING btree ("cluster_id","namespace","name");--> statement-breakpoint
CREATE INDEX "gitops_applications_org_id_idx" ON "gitops_applications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "gitops_applications_repo_url_idx" ON "gitops_applications" USING btree ("repo_url");--> statement-breakpoint
CREATE UNIQUE INDEX "workloads_namespace_kind_name_unique" ON "workloads" USING btree ("namespace_id","kind","name") WHERE "workloads"."kind" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workloads_namespace_name_unresolved_kind_unique" ON "workloads" USING btree ("namespace_id","name") WHERE "workloads"."kind" IS NULL;--> statement-breakpoint
CREATE INDEX "workloads_org_id_idx" ON "workloads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "workloads_release_id_idx" ON "workloads" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "workloads_application_id_idx" ON "workloads" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workload_containers_identity_unique" ON "workload_containers" USING btree ("workload_id","name","image_id");--> statement-breakpoint
CREATE INDEX "workload_containers_org_id_idx" ON "workload_containers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "workload_containers_image_id_idx" ON "workload_containers" USING btree ("image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "images_cluster_digest_unique" ON "images" USING btree ("cluster_id","digest");--> statement-breakpoint
CREATE INDEX "images_org_id_idx" ON "images" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "images_registry_repository_idx" ON "images" USING btree ("registry","repository");--> statement-breakpoint
CREATE INDEX "images_last_seen_at_idx" ON "images" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sboms_image_id_unique" ON "sboms" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "sboms_sha256_idx" ON "sboms" USING btree ("sbom_sha256");--> statement-breakpoint
CREATE INDEX "components_sbom_id_type_idx" ON "components" USING btree ("sbom_id","type");--> statement-breakpoint
CREATE INDEX "components_purl_idx" ON "components" USING btree ("purl");--> statement-breakpoint
CREATE INDEX "components_name_idx" ON "components" USING btree ("name");--> statement-breakpoint
CREATE INDEX "components_sbom_direct_idx" ON "components" USING btree ("sbom_id") WHERE "components"."is_direct" = true AND "components"."type" = 'library';--> statement-breakpoint
CREATE INDEX "comp_dep_parent_component_id_idx" ON "component_dependencies" USING btree ("parent_component_id");--> statement-breakpoint
CREATE INDEX "comp_dep_child_component_id_idx" ON "component_dependencies" USING btree ("child_component_id");--> statement-breakpoint
CREATE INDEX "component_external_refs_component_id_idx" ON "component_external_refs" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "component_properties_component_id_idx" ON "component_properties" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "comp_vuln_vuln_id_idx" ON "component_vulnerabilities" USING btree ("vulnerability_id");--> statement-breakpoint
CREATE INDEX "vulnerabilities_id_prefix_idx" ON "vulnerabilities" USING btree ("id_prefix");--> statement-breakpoint
CREATE INDEX "vulnerabilities_cvss_score_idx" ON "vulnerabilities" USING btree ("cvss_score");--> statement-breakpoint
CREATE INDEX "vulnerabilities_risk_score_idx" ON "vulnerabilities" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX "vulnerabilities_kev_listed_at_idx" ON "vulnerabilities" USING btree ("kev_listed_at") WHERE "vulnerabilities"."kev_listed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vulnerabilities_severity_level_idx" ON "vulnerabilities" USING btree ("severity_level");--> statement-breakpoint
CREATE INDEX "vulnerabilities_source_idx" ON "vulnerabilities" USING btree ("source");--> statement-breakpoint
CREATE INDEX "vulnerabilities_modified_at_idx" ON "vulnerabilities" USING btree ("modified_at");--> statement-breakpoint
CREATE INDEX "vulnerabilities_aliases_gin_idx" ON "vulnerabilities" USING gin ("aliases");--> statement-breakpoint
CREATE INDEX "vulnerabilities_finding_identity_idx" ON "vulnerabilities" USING btree ("finding_identity");--> statement-breakpoint
CREATE INDEX "vulnerabilities_withdrawn_at_idx" ON "vulnerabilities" USING btree ("withdrawn_at") WHERE "vulnerabilities"."withdrawn_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vuln_affected_pkg_vuln_id_pkg_name_idx" ON "vulnerability_affected_packages" USING btree ("vulnerability_id","package_name");--> statement-breakpoint
CREATE INDEX "vuln_affected_pkg_match_key_idx" ON "vulnerability_affected_packages" USING btree ("match_key") WHERE "vulnerability_affected_packages"."withdrawn" = false;--> statement-breakpoint
CREATE INDEX "vuln_affected_pkg_generation_idx" ON "vulnerability_affected_packages" USING btree ("generation");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("priority" DESC NULLS LAST,"created_at") WHERE "jobs"."status" IN ('pending', 'scheduled');--> statement-breakpoint
CREATE INDEX "jobs_completed_at_idx" ON "jobs" USING btree ("completed_at") WHERE "jobs"."status" IN ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "jobs_scheduled_for_idx" ON "jobs" USING btree ("scheduled_for") WHERE "jobs"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "jobs_org_id_idx" ON "jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "jobs_image_id_type_created_idx" ON "jobs" USING btree ("image_id","type","created_at");--> statement-breakpoint
CREATE INDEX "jobs_sbom_id_idx" ON "jobs" USING btree ("sbom_id");--> statement-breakpoint
CREATE INDEX "vuln_scan_runs_image_created_idx" ON "vulnerability_scan_runs" USING btree ("image_id","created_at");--> statement-breakpoint
CREATE INDEX "vuln_scan_runs_sbom_id_idx" ON "vulnerability_scan_runs" USING btree ("sbom_id");--> statement-breakpoint
CREATE INDEX "vuln_scan_runs_job_id_idx" ON "vulnerability_scan_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "osv_sync_failures_run_occurred_idx" ON "osv_sync_failures" USING btree ("sync_run_id","occurred_at");--> statement-breakpoint
CREATE INDEX "osv_sync_failures_occurred_at_idx" ON "osv_sync_failures" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "osv_sync_runs_completed_at_idx" ON "osv_sync_runs" USING btree ("completed_at");--> statement-breakpoint
CREATE INDEX "osv_sync_runs_mode_idx" ON "osv_sync_runs" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "activity_events_org_created_idx" ON "activity_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_issue_id_idx" ON "activity_events" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "activity_events_image_id_idx" ON "activity_events" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "activity_events_cluster_id_idx" ON "activity_events" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_states_org_finding_unique" ON "finding_states" USING btree ("org_id","package_type","package_name","vuln_identity");--> statement-breakpoint
CREATE INDEX "issues_org_state_idx" ON "issues" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "issues_cluster_state_idx" ON "issues" USING btree ("cluster_id","state");--> statement-breakpoint
CREATE INDEX "issues_image_id_idx" ON "issues" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "issues_release_id_idx" ON "issues" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "issues_vuln_identity_idx" ON "issues" USING btree ("vuln_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_repo_entries_repo_chart_unique" ON "chart_repo_entries" USING btree ("repository_id","chart_name");--> statement-breakpoint
CREATE INDEX "chart_repo_entries_chart_name_idx" ON "chart_repo_entries" USING btree ("chart_name");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_repositories_org_url_unique" ON "chart_repositories" USING btree ("org_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_hub_packages_repo_name_unique" ON "artifact_hub_packages" USING btree ("repo_name","name");--> statement-breakpoint
CREATE INDEX "artifact_hub_packages_name_idx" ON "artifact_hub_packages" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_attributions_org_chart_unique" ON "chart_attributions" USING btree ("org_id","chart_name");--> statement-breakpoint
CREATE INDEX "chart_attributions_package_id_idx" ON "chart_attributions" USING btree ("package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_image_observations_chart_ref_unique" ON "chart_image_observations" USING btree ("repo_url","chart_name","chart_version","image_ref");--> statement-breakpoint
CREATE INDEX "chart_image_observations_chart_idx" ON "chart_image_observations" USING btree ("repo_url","chart_name","chart_version");--> statement-breakpoint
CREATE INDEX "chart_image_observations_digest_idx" ON "chart_image_observations" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_renders_repo_chart_version_unique" ON "chart_renders" USING btree ("repo_url","chart_name","chart_version");--> statement-breakpoint
CREATE INDEX "org_metrics_snapshots_org_id_captured_at_idx" ON "org_metrics_snapshots" USING btree ("org_id","captured_at");--> statement-breakpoint
CREATE INDEX "cluster_metrics_snapshots_cluster_id_captured_at_idx" ON "cluster_metrics_snapshots" USING btree ("cluster_id","captured_at");