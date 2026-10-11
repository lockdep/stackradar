import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { clusters } from "./clusters.js";

/**
 * Helm releases — the third grouping axis over the same workload rows,
 * alongside namespace (the folder view) and image (the remediation view).
 *
 * Built from labels and annotations the agent already collects.
 *
 * Three traps this schema encodes rather than leaves to callers:
 *
 * - **`namespace` is the *release's* namespace**, from
 *   `meta.helm.sh/release-namespace`, never the workload's. A chart may deploy
 *   resources into other namespaces, and keying on the workload's namespace
 *   silently splits one release into several.
 * - **A release name is not unique across namespaces**, so the key is the
 *   triple `(clusterId, namespace, name)`.
 * - **A chart name is not unique across repositories** — several repos publish
 *   `nginx`. `repoUrl` is nullable because pod metadata cannot supply it, so
 *   fleet-wide "all releases of chart X" is a *name* match until it is known,
 *   and the UI has to say so rather than imply the releases are the same chart.
 *
 * Modelled as its own relation rather than a `deployment_sources` table with a
 * `kind` discriminator: ArgoCD commonly deploys *via* Helm, so a workload
 * legitimately has both at different layers and a discriminator would force a
 * choice between two true answers. That sibling table is
 * [`gitops_applications`](./gitops-applications.ts), and this table has **no
 * `source` column** as a result — every row here is a Helm release, and a
 * column whose only value is `"helm"` is a column that invites someone to write
 * `"argocd"` into it later. Flux is not an exception: it installs *through* the
 * Helm SDK, so a `HelmRelease` CR produces a genuine row here **and** a
 * `gitops_applications` row with `tool: "flux"`.
 */
export const helmReleases = pgTable(
    "helm_releases",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        clusterId: uuid("cluster_id").notNull(),

        /** The release's own namespace — see the class comment. */
        namespace: varchar("namespace", { length: 253 }).notNull(),
        name: varchar("name", { length: 253 }).notNull(),

        chartName: varchar("chart_name", { length: 253 }),
        chartVersion: varchar("chart_version", { length: 128 }),
        /**
         * The **application's** version, from `app.kubernetes.io/version` — not the
         * chart's, even where the two are byte-identical. Plenty of charts stamp
         * their own version into that label, so equality is not evidence the two
         * mean the same thing, and nothing may derive one from the other. The
         * remediation chain's proof that a fix landed is the measured image digest,
         * never this.
         */
        appVersion: varchar("app_version", { length: 128 }),

        /** `null` means unknown, not "no repo". Only an ArgoCD/Flux source object can supply it. */
        repoUrl: text("repo_url"),

        firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("helm_releases_cluster_namespace_name_unique").on(table.clusterId, table.namespace, table.name),
        index("helm_releases_org_id_idx").on(table.orgId),
        /** Anchor for `workloads.release_id`. See `clusters.ts`. */
        uniqueIndex("helm_releases_id_org_unique").on(table.id, table.orgId),
        /** A release cannot belong to another org's cluster. */
        foreignKey({
            columns: [table.clusterId, table.orgId],
            foreignColumns: [clusters.id, clusters.orgId],
            name: "helm_releases_cluster_id_org_id_fk",
        }).onDelete("cascade"),
        // "Every release of chart X across the fleet" — a name match, with the
        // repoUrl caveat above.
        index("helm_releases_chart_name_idx").on(table.chartName),
    ],
);

export type HelmRelease = typeof helmReleases.$inferSelect;
