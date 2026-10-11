import { db, schema } from "../db/index.js";

/**
 * A point-in-time view of the OSV mirror's health, shaped for Prometheus
 * exposition.
 *
 * Deliberately cheap: one read of the single-row `osv_sync_state` table and
 * nothing else. This is scraped every 15-30s by every server replica, so
 * anything proportional to mirror size does not belong here — a `count(*)`
 * over ~900k vulnerabilities or ~4M affected packages would turn a health
 * check into a recurring sequential scan. Those totals are available on
 * demand via `GET /api/admin/osv`.
 */
export interface OsvMirrorHealth {
    /** Null before the first sync run creates the state row. */
    initialized: boolean;
    syncStatus: string;
    lastSuccessfulPollAt: Date | null;
    lastModifiedSeen: Date | null;
    lastModifiedApplied: Date | null;
    consecutiveFailures: number;
}

export const osvMetricsRepository = {
    /**
     * Returns null when the state row does not exist yet, which is a genuinely
     * different condition from "initialized = false" — it means the sync has
     * never been invoked at all, not that it ran and has no generation.
     */
    async getMirrorHealth(): Promise<OsvMirrorHealth | null> {
        const [state] = await db.select().from(schema.osvSyncState).limit(1);
        if (!state) return null;

        return {
            initialized: state.initialized,
            syncStatus: state.syncStatus,
            lastSuccessfulPollAt: state.lastSuccessfulPollAt,
            lastModifiedSeen: state.lastModifiedSeen,
            lastModifiedApplied: state.lastModifiedApplied,
            consecutiveFailures: state.consecutiveFailures,
        };
    },
};
