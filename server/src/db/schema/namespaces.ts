import { pgTable, uuid, varchar, timestamp, jsonb, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { clusters } from "./clusters.js";

/**
 * Kubernetes namespaces — the "folder" the workloads list browses by.
 *
 * A real entity rather than the `projects` row with `type: "group"` it
 * replaces, which buys three things a self-referencing tree could not:
 *
 * - Browsing is a plain join instead of a recursive tree walk.
 * - There is somewhere to hang namespace labels (`environment=prod`), which
 *   `risk-ranking.md` needs and a name-only group row had no room for.
 * - A namespace with zero scanned workloads is representable. A `"group"` with
 *   no children was indistinguishable from one that was never created.
 */
export const namespaces = pgTable("namespaces", {
    id: uuid("id").primaryKey().defaultRandom(),

    // Denormalised from the cluster for org-scoped listings and cascade.
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").notNull(),

    name: varchar("name", { length: 253 }).notNull(),

    /**
     * **`null` and `{}` mean different things and must not be collapsed.**
     * `null` is "we did not collect them" — the scanner lacks namespace-read
     * RBAC — and `{}` is "we looked and there are none". Collapsing them makes
     * a permissions failure indistinguishable from an unlabelled namespace.
     * See [the inventory contract](../../../../docs/contracts/inventory-v3.md).
     */
    labels: jsonb("labels").$type<Record<string, string>>(),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Bumped by every inventory report that still contains this namespace. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex("namespaces_cluster_name_unique").on(table.clusterId, table.name),
    /** Anchor for `workloads`. See `clusters.ts`. */
    uniqueIndex("namespaces_id_org_unique").on(table.id, table.orgId),
    /**
     * Carries the tenant into the reference: a namespace cannot point at a
     * cluster belonging to a different org. Replaces the plain
     * `cluster_id -> clusters.id` FK rather than sitting beside it — the
     * composite implies the simple one. See `clusters.ts`.
     */
    foreignKey({
        columns: [table.clusterId, table.orgId],
        foreignColumns: [clusters.id, clusters.orgId],
        name: "namespaces_cluster_id_org_id_fk",
    }).onDelete("cascade"),
    // Org-wide listings and the org metrics aggregate.
    index("namespaces_org_id_idx").on(table.orgId),
]);

export type Namespace = typeof namespaces.$inferSelect;
