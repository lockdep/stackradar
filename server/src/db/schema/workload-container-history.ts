import { pgTable, uuid, varchar, text, boolean, timestamp, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { clusters } from "./clusters.js";
import { workloads } from "./workloads.js";
import { images } from "./images.js";

/**
 * The past of `workload_containers`, as **intervals**: this slot ran this
 * digest from one inventory report until another.
 * [activity-feed.md](../../../../docs/proposals/activity-feed.md) §1.
 *
 * A *slot* is the thing that has identity across digests — a workload plus a
 * container name. `api` in `prod/web` is one slot that runs digest A, then B.
 * `workload_containers` cannot name it: that table is keyed on the digest by
 * design, so a move is one row deleted and one inserted, and the inventory
 * write path deletes the before-state in the same transaction. This table
 * is what remembers.
 *
 * A **transition** is derived — an interval closed and another opened on the
 * same slot — never stored, which is what keeps rollouts, canaries and
 * retags honest: a half-finished rollout is two open intervals, a canary
 * that never completes stays two open intervals, and a `:latest` that
 * silently re-pulled is a closed interval and an open one with equal tags.
 *
 * The live table stays untouched. Every read path, tenancy check and the
 * coverage `LEFT JOIN` depend on `workload_containers` meaning "what runs
 * now", and a `gone_at` column there would turn each of them into "and not
 * gone". This is the same relationship `vulnerability_scan_runs` has to
 * `component_vulnerabilities`: the live table is the present, this is the
 * past.
 *
 * The naming facts are denormalised exactly as `issues` does it, so a row
 * outlives the workload, namespace or image it points at: `workloads` are
 * pruned and recreated with new ids on every disappearance, and the image
 * GC reclaims digests nothing runs. Both references `SET NULL`.
 *
 * The cluster reference **cascades**, following the inventory convention
 * rather than the `issues` one — the proposal's open question 2, decided:
 * `activity_events` already cascades from `clusters`, so a deleted cluster's
 * feed is gone either way, and `cluster.repository.delete` promises that
 * nothing of a cluster's data outlives it.
 */
export const workloadContainerHistory = pgTable("workload_container_history", {
    // uuidv7(): rows are appended in report order and read by range.
    id: uuid("id").primaryKey().default(sql`uuidv7()`),

    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").notNull(),

    /** Nullable: workloads are pruned and recreated with new ids. */
    workloadId: uuid("workload_id").references(() => workloads.id, { onDelete: "set null" }),

    /* The durable slot key, denormalised. */
    namespace: varchar("namespace", { length: 253 }).notNull(),
    /** `null` = unknown, never `"Pod"` — same rule as `workloads.kind`. */
    workloadKind: varchar("workload_kind", { length: 63 }),
    workloadName: varchar("workload_name", { length: 253 }).notNull(),
    containerName: varchar("container_name", { length: 253 }).notNull(),
    init: boolean("init").notNull().default(false),

    /** Nullable: the image GC must not erase history. */
    imageId: uuid("image_id").references(() => images.id, { onDelete: "set null" }),
    /** Denormalised, like `issues.from_digest`. The interval's identity. */
    digest: varchar("digest", { length: 128 }).notNull(),
    repository: varchar("repository", { length: 512 }),
    /** `null` = digest-pinned, never `"latest"`. */
    imageTag: varchar("image_tag", { length: 255 }),
    imageRef: text("image_ref").notNull(),

    /** The report that first saw the slot on this digest. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** The report that first did not. `null` = current. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [
    index("wc_history_cluster_started_idx").on(table.clusterId, table.startedAt),
    /** The open-interval read on every inventory report: `cluster_id = ? AND ended_at IS NULL`. */
    index("wc_history_cluster_ended_idx").on(table.clusterId, table.endedAt),
    /** Covers the SET NULL sweep on image GC. */
    index("wc_history_image_id_idx").on(table.imageId),
    /** Covers the SET NULL sweep when workloads are pruned. */
    index("wc_history_workload_id_idx").on(table.workloadId),
    /** Backs the retention sweep, which ages on `ended_at` — an open interval is current and never swept. */
    index("wc_history_org_ended_idx").on(table.orgId, table.endedAt),
    /**
     * A slot's whole past, newest first — the exposure walk
     * (`lib/exposure.ts`) reads every interval of a set of slots, open and
     * closed, which the partial unique index below cannot serve.
     */
    index("wc_history_slot_started_idx")
        .on(table.clusterId, table.namespace, table.workloadName, table.containerName, table.startedAt),
    /**
     * One open interval per (slot, digest). Keyed on the denormalised slot
     * rather than `workload_id`, because the id is what a prune-and-recreate
     * loses and the slot is what it keeps.
     */
    uniqueIndex("wc_history_open_slot_unique")
        .on(table.clusterId, table.namespace, table.workloadName, table.containerName, table.digest)
        .where(sql`${table.endedAt} IS NULL`),
    /** A history row cannot point at another org's cluster. */
    foreignKey({
        columns: [table.clusterId, table.orgId],
        foreignColumns: [clusters.id, clusters.orgId],
        name: "wc_history_cluster_id_org_id_fk",
    }).onDelete("cascade"),
]);

export type WorkloadContainerHistory = typeof workloadContainerHistory.$inferSelect;
export type NewWorkloadContainerHistory = typeof workloadContainerHistory.$inferInsert;
