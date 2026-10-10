import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { clusters } from "./clusters.js";

/**
 * The tools that *deliver* a workload. Both may package via Helm.
 *
 * Unknown values are rejected rather than stored — an unrecognised one would
 * become a silent third state that nothing renders and nothing filters on.
 * `flux` is accepted but not yet producible: the agent reads ArgoCD's tracking
 * annotation and `Application` objects, not `HelmRelease` or `Kustomization`.
 */
export const GITOPS_TOOLS = ["argocd", "flux"] as const;
export type GitopsTool = typeof GITOPS_TOOLS[number];

/**
 * GitOps applications — the **delivery** layer, sibling to `helm_releases`.
 *
 * Its own relation rather than a `source` discriminator on `helm_releases`, and
 * that is the whole design decision. ArgoCD commonly deploys *via* Helm, so a
 * workload legitimately has both at different layers:
 *
 * - `helm_releases` answers "what chart packaged this, at what version" — the
 *   question a CVE report is written against.
 * - `gitops_applications` answers "what delivers this, and where do I change
 *   it" — for an Argo user the fix is a `targetRevision` bump, and only this
 *   row says where to make it.
 *
 * On the reference cluster fourteen of twenty-three attributed workloads have
 * *different, both-correct* answers to those two questions. A single `source`
 * column would have made each of them pick one and discard the other, and the
 * discarded half is the half the remediation flow needs.
 *
 * `namespace` is the **application object's** own namespace — `argocd`, or a
 * team namespace under apps-in-any-namespace — never its destination. The
 * destination is `destinationNamespace`, and the two differ for essentially
 * every app.
 */
export const gitopsApplications = pgTable("gitops_applications", {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").notNull(),

    /** The application object's own namespace — see the class comment. */
    namespace: varchar("namespace", { length: 253 }).notNull(),
    name: varchar("name", { length: 253 }).notNull(),

    tool: varchar("tool", { length: 20 }).notNull().$type<GitopsTool>(),

    /**
     * All four are nullable because the tracking annotation on a workload names
     * the app and nothing else. They are filled in only when the agent could
     * read the `Application` object itself, which needs its own RBAC and the
     * CRD to exist.
     *
     * `chart` and `path` are mutually exclusive in ArgoCD's own model: a chart
     * source names a chart in a Helm repository, a directory source names a
     * path in a git repository.
     */
    repoUrl: text("repo_url"),
    targetRevision: varchar("target_revision", { length: 253 }),
    chart: varchar("chart", { length: 253 }),
    path: text("path"),

    /** Where the app deploys, as distinct from where the app object lives. */
    destinationNamespace: varchar("destination_namespace", { length: 253 }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // Same natural key as a release's, and for the same reason: an app name is
    // not unique across namespaces once apps-in-any-namespace is switched on.
    uniqueIndex("gitops_applications_cluster_namespace_name_unique")
        .on(table.clusterId, table.namespace, table.name),
    index("gitops_applications_org_id_idx").on(table.orgId),
    /** Anchor for `workloads.application_id`. See `clusters.ts`. */
    uniqueIndex("gitops_applications_id_org_unique").on(table.id, table.orgId),
    /** An app cannot belong to another org's cluster. */
    foreignKey({
        columns: [table.clusterId, table.orgId],
        foreignColumns: [clusters.id, clusters.orgId],
        name: "gitops_applications_cluster_id_org_id_fk",
    }).onDelete("cascade"),
    // "Every app deployed from repository X across the fleet" — the delivery
    // equivalent of the chart-name index on `helm_releases`, and unambiguous
    // where that one is a name match.
    index("gitops_applications_repo_url_idx").on(table.repoUrl),
]);

export type GitopsApplication = typeof gitopsApplications.$inferSelect;
