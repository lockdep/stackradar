/**
 * Affected-package generation scoping.
 *
 * `vulnerability_affected_packages` is rebuilt by generation: a bootstrap writes
 * every row of generation N+1 while generation N is still being served, and only
 * once the whole rebuild has succeeded does the pointer in
 * `osv_sync_state.affected_pkg_generation` move — atomically, together with the
 * deletion of the superseded rows. Nothing is ever truncated, so a bootstrap that
 * is OOM-killed half-way is a no-op rather than an outage.
 *
 * The cost of that is a rule every reader has to keep: **a query against
 * `vulnerability_affected_packages` must be scoped to the current generation**.
 * During a rebuild an unscoped query sees both generations at once — it would
 * double-count in the admin stats and return duplicate candidates to the matcher.
 * `isCurrentGeneration()` is that scope; grep for it to find every read path.
 *
 * The pointer is resolved as a scalar subquery rather than being passed in, so
 * that no caller can forget to thread it through and no read can be served
 * against a stale in-process copy. It is an InitPlan over a single-row table,
 * evaluated once per query. The COALESCE matters: a database whose
 * `osv_sync_state` row does not exist yet (a fresh test database, a restore in
 * progress) must fall back to generation 1 — the column default — rather than
 * comparing against NULL and silently matching nothing.
 */

import { sql, type SQL } from "drizzle-orm";
import { osvSyncState } from "./schema/osv-mirror.js";
import { vulnerabilityAffectedPackages } from "./schema/vulnerabilities.js";

/** The live generation number, as a scalar subquery. */
export function currentGeneration(): SQL<number> {
    return sql<number>`COALESCE((SELECT ${osvSyncState.affectedPkgGeneration} FROM ${osvSyncState} WHERE ${osvSyncState.id} = 1), 1)`;
}

/**
 * Predicate restricting `vulnerability_affected_packages` to the live generation.
 * Add this to every query that reads the table.
 */
export function isCurrentGeneration(): SQL {
    return sql`${vulnerabilityAffectedPackages.generation} = ${currentGeneration()}`;
}
