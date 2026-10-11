import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * What a candidate chart version deploys — the chart half of the upgrade
 * recommendation (`services/upgrade-recommendation.service.ts`).
 *
 * A chart version is a public, deterministic artifact: fetch the tarball,
 * render it with default values, and the images it deploys fall out of the
 * manifests. These tables record that — and **nothing else**.
 *
 * ## No tenant columns, on purpose
 *
 * Neither table carries an `orgId` or `clusterId`. The *selection* of what to
 * render is driven by tenant data (charts customers actually run), but the
 * resulting rows state only public facts: chart X at version Y deploys these
 * image refs, which resolve to these digests. Identity is
 * `(repoUrl, chartName, chartVersion)` — the same chart identity rule the
 * upgrade recommendation uses, with the repo URL required because several
 * repositories publish `nginx`.
 *
 * Tenant reads cross into these tables only through the candidate path
 * (release → known repo → observation → platform image), never as a general
 * lookup — see `recommendForRelease`.
 */

export type ChartRenderStatus = "rendered" | "render_failed";

/**
 * One row per attempted render of a chart version. A version with a row is
 * never rendered again — a failed render is recorded with its reason and the
 * release keeps its unmeasured card, not a nightly retry loop against a chart
 * that exceeds a cap deterministically.
 */
export const chartRenders = pgTable(
    "chart_renders",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        repoUrl: text("repo_url").notNull(),
        chartName: varchar("chart_name", { length: 253 }).notNull(),
        chartVersion: varchar("chart_version", { length: 128 }).notNull(),

        status: varchar("status", { length: 20 }).notNull().$type<ChartRenderStatus>(),
        /** Why a `render_failed` failed — a cap hit, a fetch error, a helm error. */
        failureReason: text("failure_reason"),

        /** The pinned `helm` binary version that produced the manifests. */
        helmVersion: varchar("helm_version", { length: 64 }),
        /** `--kube-version` passed to the render, when the mirror supplied a range. */
        kubeVersion: varchar("kube_version", { length: 64 }),

        renderedAt: timestamp("rendered_at", { withTimezone: true }).notNull(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("chart_renders_repo_chart_version_unique").on(table.repoUrl, table.chartName, table.chartVersion),
    ],
);

export type ChartRender = typeof chartRenders.$inferSelect;
export type NewChartRender = typeof chartRenders.$inferInsert;

/**
 * `repoUrl × chartName × chartVersion × image ref → digest`.
 *
 * One row per image reference a rendered chart version deploys. `digest` is
 * the manifest-list digest the registry reported for the ref — the same
 * identity a kubelet pull-by-tag reports — and is null when resolution
 * failed or the registry is not on the public allowlist; `resolutionError`
 * says which. **Unresolved rows measure nothing**: the promotion path skips
 * them and the release degrades to its unmeasured card.
 */
export const chartImageObservations = pgTable(
    "chart_image_observations",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        repoUrl: text("repo_url").notNull(),
        chartName: varchar("chart_name", { length: 253 }).notNull(),
        chartVersion: varchar("chart_version", { length: 128 }).notNull(),

        /** The ref exactly as the rendered manifest wrote it. */
        imageRef: text("image_ref").notNull(),

        /**
         * The ref, normalised (`lib/image-ref.ts` plus docker.io shorthand
         * expansion). `registry` never `null` here — a bare ref normalises to
         * docker.io. `tag` is null for a digest-pinned ref.
         */
        registry: varchar("registry", { length: 255 }).notNull(),
        repository: varchar("repository", { length: 512 }).notNull(),
        tag: varchar("tag", { length: 255 }),

        /** Manifest-list digest per the registry, or null with a reason below. */
        digest: varchar("digest", { length: 128 }),
        resolutionError: text("resolution_error"),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // The full ref per chart version — re-rendering upserts, never duplicates.
        uniqueIndex("chart_image_observations_chart_ref_unique").on(
            table.repoUrl,
            table.chartName,
            table.chartVersion,
            table.imageRef,
        ),
        // The promotion path's read: every observation for one chart version.
        index("chart_image_observations_chart_idx").on(table.repoUrl, table.chartName, table.chartVersion),
        // The platform-scan sweep's read: which digests still need an SBOM.
        index("chart_image_observations_digest_idx").on(table.digest),
    ],
);

export type ChartImageObservation = typeof chartImageObservations.$inferSelect;
export type NewChartImageObservation = typeof chartImageObservations.$inferInsert;
