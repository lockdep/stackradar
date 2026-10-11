import { pgTable, uuid, varchar, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { artifactHubPackages } from "./artifact-hub.js";

/**
 * Chart attribution.
 *
 * The inferred answer to "which repository does this installed chart come
 * from", for releases whose `helm_releases.repo_url` the scanner could not
 * observe. Kept in its own table on purpose: **inferred data never lands in
 * observed columns.** `helm_releases.repo_url` stays ArgoCD-observed-only;
 * read-side services resolve the repo via this table when the observed value
 * is null, and label the result as an inference.
 *
 * Rows are written only by the nightly attribution pass
 * (`artifacthub-sync/attribution.ts`), which requires version-list identity
 * evidence and refuses ties — see `lib/chart-attribution.ts`. The pass
 * stamp-and-prunes on `matched_at`, so a chart that stops matching or is no
 * longer installed loses its attribution nightly.
 *
 * The `package_id` cascade means the mirror prune deletes attributions of
 * packages that vanished from the dump mid-cron. Safe only because the
 * attribution pass runs immediately after the mirror refresh in the same
 * cron — see `artifacthub-sync/README.md`.
 */
export const chartAttributions = pgTable(
    "chart_attributions",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),

        /** One answer per `(org, chart)` — every installed version must agree. */
        chartName: varchar("chart_name", { length: 253 }).notNull(),

        packageId: uuid("package_id")
            .notNull()
            .references(() => artifactHubPackages.id, { onDelete: "cascade" }),

        /** Denormalised from the package for the read path. */
        repoUrl: text("repo_url").notNull(),

        /** The matcher's evidence record — per-candidate score breakdown. */
        evidence: jsonb("evidence").notNull(),

        /** Stamp-and-prune stamp for the nightly pass. */
        matchedAt: timestamp("matched_at", { withTimezone: true }).notNull(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("chart_attributions_org_chart_unique").on(table.orgId, table.chartName),
        /** Covers the CASCADE from artifact_hub_packages when the mirror prunes. */
        index("chart_attributions_package_id_idx").on(table.packageId),
    ],
);
