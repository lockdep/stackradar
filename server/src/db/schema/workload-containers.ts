import {
    pgTable,
    uuid,
    varchar,
    text,
    boolean,
    integer,
    timestamp,
    uniqueIndex,
    index,
    foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { workloads } from "./workloads.js";
import { images } from "./images.js";

/**
 * The running thing: one container of one workload, on one image.
 *
 * **Identity includes `imageId`.** During a rollout a Deployment legitimately
 * runs two digests at once, and the honest record is two rows for `api` — one
 * on the old digest with 1 pod, one on the new with 2. A model keyed only on
 * `(workloadId, name)` cannot represent a half-finished rollout, so it would
 * report a fix as deployed while the vulnerable digest is still serving
 * traffic. That state *is* the answer to "is the fix actually live", which is
 * why the digest is in the key rather than tolerated as an edge case. See
 * [the inventory contract](../../../../docs/contracts/inventory-v3.md#container-identity-includes-the-digest).
 *
 * This table is also where every **deployment** fact lives — the tag that was
 * asked for, the ref, how many pods are running it. None of it belongs on
 * `sboms`: an SBOM describes a document, and deployment context is a fact
 * about one running container (see the `sboms` table comment and ADR 0006).
 */
export const workloadContainers = pgTable(
    "workload_containers",
    {
        // uuidv7() (PG18): time-ordered UUIDs for PK index locality — identity
        // includes image_id, so every rollout is delete+insert churn on this
        // table.
        id: uuid("id")
            .primaryKey()
            .default(sql`uuidv7()`),

        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        workloadId: uuid("workload_id").notNull(),

        name: varchar("name", { length: 253 }).notNull(),

        /**
         * Init containers run, so their images can be vulnerable, but they are not
         * serving traffic. Collected either way; the flag lets ranking treat them
         * differently instead of guessing from the name.
         */
        init: boolean("init").notNull().default(false),

        /** `restrict`, not cascade: an image with a container on it is in use. */
        imageId: uuid("image_id")
            .notNull()
            .references(() => images.id, { onDelete: "restrict" }),

        /** The reference the pod spec asked for, verbatim. */
        imageRef: text("image_ref").notNull(),

        /**
         * The tag the deployment asked for. **`null` for a digest-pinned
         * deployment** — there is no tag, and inventing `"latest"` labels every
         * distinct image identically.
         */
        imageTag: varchar("image_tag", { length: 255 }),

        /**
         * Pods observed running *this* container on *this* digest. Deliberately
         * per-row rather than per-workload: mid-rollout the two rows for one
         * container name do not sum to the workload's pod count, and that gap is
         * the information.
         */
        runningPods: integer("running_pods"),

        firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
        lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("workload_containers_identity_unique").on(table.workloadId, table.name, table.imageId),
        index("workload_containers_org_id_idx").on(table.orgId),
        /**
         * The most load-bearing of these. `workload_containers.org_id` is the
         * column `deployedImages`, `findDeployments` and every check in
         * `db/tenancy.ts` filter on, so this row's tenant *is* the answer to "may
         * this org see this image". It must equal its workload's — see `clusters.ts`.
         */
        foreignKey({
            columns: [table.workloadId, table.orgId],
            foreignColumns: [workloads.id, workloads.orgId],
            name: "workload_containers_workload_id_org_id_fk",
        }).onDelete("cascade"),
        // The remediation lens: "every place this image runs" — one action, N
        // workloads. Also the coverage LEFT JOIN's probe side.
        index("workload_containers_image_id_idx").on(table.imageId),
    ],
);

export type WorkloadContainer = typeof workloadContainers.$inferSelect;
export type NewWorkloadContainer = typeof workloadContainers.$inferInsert;
