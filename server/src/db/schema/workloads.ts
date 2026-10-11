import { pgTable, uuid, varchar, timestamp, integer, jsonb, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { namespaces } from "./namespaces.js";
import { helmReleases } from "./helm-releases.js";
import { gitopsApplications } from "./gitops-applications.js";

/**
 * Workloads — a Deployment, StatefulSet, DaemonSet, CronJob or bare Pod.
 *
 * Identity is `(namespaceId, kind, name)`. `kind` is resolved from the pod's
 * `ownerReferences` by the scanner and is **nullable**: when the owner chain
 * dead-ends the honest answer is "unknown", not the literal `"Pod"`. A guessed
 * kind is worse than an absent one, because `remediation-workflow.md` turns it
 * into a `kubectl`/`helm` command.
 */
export const workloads = pgTable(
    "workloads",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        namespaceId: uuid("namespace_id").notNull(),

        /** `null` when `ownerReferences` could not be resolved — never guessed. */
        kind: varchar("kind", { length: 63 }),
        name: varchar("name", { length: 253 }).notNull(),

        /**
         * Nullable by design: most clusters run plenty of workloads no chart
         * manages, and those must appear as a visible "unmanaged" group rather
         * than disappear from a release-grouped view.
         *
         * `set null` rather than cascade — losing the release should not delete the
         * workload, which is still running.
         */
        releaseId: uuid("release_id").references(() => helmReleases.id, { onDelete: "set null" }),

        /**
         * What **delivers** this workload, as distinct from what packaged it.
         *
         * A second, independent reference rather than a value on the release: on a
         * cluster where ArgoCD renders Helm charts most workloads have both, and
         * both are true. The chart version is what a CVE report cites; the Argo app
         * is where the fix is made.
         *
         * Nullable and `set null` for the same reasons as `releaseId` — plenty of
         * workloads no GitOps tool delivers (including, usually, the scanner
         * itself), and a workload whose app row is lost should go unattributed
         * rather than disappear.
         */
        applicationId: uuid("application_id").references(() => gitopsApplications.id, { onDelete: "set null" }),

        /** Pods **observed**, not `spec.replicas`. An observation, not an intent. */
        runningPods: integer("running_pods"),

        /**
         * Labels off the pod template **merged over the controller's**, the pod
         * winning any key both carry. Same null-vs-`{}` rule as `namespaces.labels`.
         *
         * The merge is what puts `app.kubernetes.io/part-of` here for a workload
         * whose pod template never carried it, which is what lets the UI sub-group
         * the unmanaged bucket without a new column or a fabricated release.
         */
        labels: jsonb("labels").$type<Record<string, string>>(),

        /** Earliest pod start the informer saw — how long this has been running. */
        firstStartedAt: timestamp("first_started_at", { withTimezone: true }),

        firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // Split into two partial indexes because Postgres treats NULL as distinct
        // in a composite unique constraint, so a single UNIQUE(namespace_id, kind,
        // name) would happily admit two kind-unresolved workloads with the same
        // name. Same reasoning the old `projects` table used for `parent_id`.
        uniqueIndex("workloads_namespace_kind_name_unique")
            .on(table.namespaceId, table.kind, table.name)
            .where(sql`${table.kind} IS NOT NULL`),
        uniqueIndex("workloads_namespace_name_unresolved_kind_unique")
            .on(table.namespaceId, table.name)
            .where(sql`${table.kind} IS NULL`),
        index("workloads_org_id_idx").on(table.orgId),
        /** Anchor for `workload_containers`. See `clusters.ts`. */
        uniqueIndex("workloads_id_org_unique").on(table.id, table.orgId),
        /** A workload cannot live in another org's namespace. */
        foreignKey({
            columns: [table.namespaceId, table.orgId],
            foreignColumns: [namespaces.id, namespaces.orgId],
            name: "workloads_namespace_id_org_id_fk",
        }).onDelete("cascade"),
        /*
         * Packaging and delivery. These keep their single-column FKs (declared on
         * the columns above) because those carry `ON DELETE SET NULL` — a workload
         * outlives the release that packaged it. The composite cannot carry that
         * action: `SET NULL` would null `org_id` too, and `org_id` is `NOT NULL`.
         * So these are plain `NO ACTION` consistency checks and the single-column
         * FKs stay the ones that decide what a delete does. When a release is
         * deleted its `release_id` goes null first, and MATCH SIMPLE stops checking
         * a composite key containing a null — which is exactly the wanted result.
         */
        foreignKey({
            columns: [table.releaseId, table.orgId],
            foreignColumns: [helmReleases.id, helmReleases.orgId],
            name: "workloads_release_id_org_id_fk",
        }),
        foreignKey({
            columns: [table.applicationId, table.orgId],
            foreignColumns: [gitopsApplications.id, gitopsApplications.orgId],
            name: "workloads_application_id_org_id_fk",
        }),
        // The release lens: "every workload this chart deploys", including the ones
        // that landed in another namespace.
        index("workloads_release_id_idx").on(table.releaseId),
        // The delivery lens: "every workload this Argo app deploys". A separate
        // index from the release one because the two group differently — an app may
        // deliver several charts, and a chart may be delivered by several apps.
        index("workloads_application_id_idx").on(table.applicationId),
    ],
);

export type Workload = typeof workloads.$inferSelect;
export type NewWorkload = typeof workloads.$inferInsert;
