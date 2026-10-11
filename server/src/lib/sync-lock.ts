/**
 * Thrown inside a feed sync's apply transaction when
 * `pg_try_advisory_xact_lock` finds another process already applying the
 * same feed (EPSS, KEV). The workers map it to a skipped run rather than a
 * failed one: the work is being done, just not here. Two monolith replicas
 * (`src/topology.ts`) firing the same cron minute is the case it exists for.
 */
export class SyncLockHeldError extends Error {
    constructor(readonly feed: string) {
        super(`${feed} apply is already running in another process (advisory lock held)`);
        this.name = "SyncLockHeldError";
    }
}
