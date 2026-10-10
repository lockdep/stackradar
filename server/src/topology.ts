/**
 * How the server process is deployed — one process or several
 * (docs/open-source-plan-2026-10-10.md step 06).
 *
 * - **monolith** (the community default): the HTTP server also runs the job
 *   worker loop (`jobs/job-worker.ts`) and the in-process sync scheduler
 *   (`sync-scheduler.ts`) — the hourly OSV incremental sync, the twice-daily
 *   bootstrap check, the daily EPSS, KEV and Artifact Hub feeds. A
 *   community install is `server` + `client` + the scanner, nothing else.
 *   Replicas stay safe: the job queue claims with `SKIP LOCKED`, the OSV
 *   sync holds a session advisory lock, EPSS and KEV take a transaction
 *   advisory lock on their apply, so a second replica never double-runs.
 * - **split** (the cloud): the server is HTTP-only; `dist/src/worker.js`
 *   and the sync CLIs run as their own Deployment and CronJobs, exactly as
 *   before this switch existed.
 *
 * Read once from `TOPOLOGY`. Unset follows the edition — monolith for
 * community, split for the cloud — so the cloud's deployments did not have
 * to change the day this landed; anything else refuses to boot.
 */

import { edition } from "./edition.js";

export type Topology = "monolith" | "split";

export const TOPOLOGY_ENV_VAR = "TOPOLOGY";

export class TopologyError extends Error {
    constructor(raw: string) {
        super(`${TOPOLOGY_ENV_VAR} must be "monolith" or "split" (got ${JSON.stringify(raw)}); refusing to start`);
        this.name = "TopologyError";
    }
}

/** The pure resolver: unset or empty follows the edition, the two names are themselves, anything else throws. */
export function resolveTopology(raw: string | undefined, caps: { isCloud: boolean }): Topology {
    const value = (raw ?? "").trim();
    if (value === "") return caps.isCloud ? "split" : "monolith";
    if (value === "monolith" || value === "split") return value;
    throw new TopologyError(raw ?? "");
}

/** The process's topology. Importing this module is what refuses a bad value. */
export const topology: Topology = resolveTopology(process.env[TOPOLOGY_ENV_VAR], edition);
