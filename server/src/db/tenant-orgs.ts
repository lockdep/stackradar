/**
 * Which organisations and clusters are **tenants** — rows a customer looks
 * at — as opposed to the two StackRadar-owned kinds:
 *
 * - `system` (the platform org/cluster the candidate-chart scanner writes
 *   under), and
 * - `demo` (the public read-only demo org).
 *
 * Platform-wide sweeps that count or snapshot "our customers" use these so
 * the two exclusions cannot drift apart: a metric that excluded one and not
 * the other would report the demo cluster's staged findings as customer
 * risk.
 *
 * Clusters carry only `system`; the demo cluster is recognised through its
 * org, which is why the cluster predicate is an `EXISTS` and not a column.
 *
 * Not to be confused with `tenancy.ts`, which answers "may this org see this
 * image" — a per-request ownership check, not a classification of orgs.
 */

import { and, eq, sql, type SQL } from "drizzle-orm";
import { organizations, clusters } from "./schema/index.js";

/** `organizations` rows that are neither the platform org nor the demo org. */
export function isTenantOrg(): SQL {
    return and(eq(organizations.system, false), eq(organizations.demo, false))!;
}

/** `clusters` rows that are neither the platform cluster nor owned by the demo org. */
export function isTenantCluster(): SQL {
    return and(
        eq(clusters.system, false),
        sql`NOT EXISTS (
            SELECT 1 FROM ${organizations}
            WHERE ${organizations.id} = ${clusters.orgId}
              AND ${organizations.demo} = true
        )`,
    )!;
}
