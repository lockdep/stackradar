import { pgTable, uuid, varchar, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/**
 * Clusters table
 * Represents a Kubernetes cluster monitored by the StackRadar scanner agent.
 * Each cluster has its own API key for scanner authentication.
 */
export const clusters = pgTable("clusters", {
    id: uuid("id").primaryKey().defaultRandom(),

    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),

    // Reported by the scanner agent via the `X-Scanner-Version` request header
    // (populated from the Helm chart version on install). Nullable because
    // legacy scanners or clusters that have never phoned home won't have a
    // value yet; the UI uses this to flag clusters running outdated scanners.
    scannerVersion: varchar("scanner_version", { length: 64 }),
    scannerLastSeenAt: timestamp("scanner_last_seen_at", { withTimezone: true }),

    /**
     * The cluster's Kubernetes `gitVersion` (e.g. `v1.29.4+k3s1`), reported by
     * the scanner via the `X-Kubernetes-Version` heartbeat header. Null =
     * unknown — an older scanner, or one whose `/version` read failed — same
     * null-is-not-false discipline as `ownerMetadataCollected`; an absent
     * header never erases a stored value. Consumed by `lib/kube-constraint.ts`
     * to warn when a suggested chart version excludes this cluster.
     */
    kubernetesVersion: varchar("kubernetes_version", { length: 64 }),

    /**
     * Whether the last inventory report could read its workloads' controllers.
     *
     * `null` until a report arrives; `false` when the agent was not permitted
     * to read Deployments and StatefulSets, or has the lookup switched off.
     *
     * Stored rather than left in the response because the *client* is what has
     * to say it. Without this flag "no chart claims these workloads" and "we
     * were not allowed to look" render identically, and the UI states the first
     * while the second is true — which is exactly how chart-managed workloads
     * sat under Unmanaged for a release without anyone noticing. Same
     * null-is-not-false discipline as `namespaces.labels`.
     */
    ownerMetadataCollected: boolean("owner_metadata_collected"),

    /**
     * The StackRadar-owned platform cluster the `platform_scan` worker writes
     * candidate-image SBOMs under — see `organizations.system`. Never a
     * customer cluster: no API key can be minted for it
     * (`cluster.repository.ts` guards), so nothing outside this codebase can
     * ever upload into it.
     */
    system: boolean("system").notNull().default(false),

    /**
     * When this cluster's first inventory report landed — the start of what
     * we have observed. Set once by the inventory write path and never moved.
     * `null` = never reported. `lib/exposure.ts` reads it to tell "started
     * then" from "was already running when we first looked": an interval
     * that begins at or before this instant is a lower bound, forever.
     */
    firstInventoryAt: timestamp("first_inventory_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("clusters_name_org_unique").on(table.name, table.orgId),
    /**
     * The anchor for tenant-carrying foreign keys.
     *
     * `org_id` is denormalised down the whole containment chain —
     * `namespaces`, `workloads`, `workload_containers`, `helm_releases`,
     * `gitops_applications` and `api_keys` all carry one — because every read
     * path filters on it directly rather than walking back up to `clusters`.
     * Denormalised copies that nothing constrains can drift, and a single
     * drifted row is a cross-tenant leak on whichever surface trusts that copy:
     * `findDeployments` filters `workload_containers.org_id`, the release
     * surfaces filter `helm_releases.org_id`, and they would disagree.
     *
     * `UNIQUE (id, org_id)` is redundant given `id` is already the primary key.
     * It exists so children can declare `FOREIGN KEY (cluster_id, org_id)
     * REFERENCES clusters (id, org_id)` — Postgres requires a unique
     * constraint on exactly the referenced columns. That composite FK is what
     * makes "this row's tenant disagrees with its parent's" unrepresentable
     * rather than merely absent.
     *
     * `images` is deliberately *not* part of this: it carries no tenant at all
     * (ADR 0004), and authorisation for a digest is asked of
     * `workload_containers` via `db/tenancy.ts`.
     */
    uniqueIndex("clusters_id_org_unique").on(table.id, table.orgId),
    // findAllByOrg(orgId) filters on org_id alone — the unique index above
    // leads with `name` so it cannot satisfy this query. See
    // docs/db-audit/P1-missing-indexes.md § P1-4.
    index("clusters_org_id_idx").on(table.orgId),
]);

export type Cluster = typeof clusters.$inferSelect;
export type NewCluster = typeof clusters.$inferInsert;
