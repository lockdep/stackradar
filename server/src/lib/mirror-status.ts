/**
 * What the app shell is told about the three vulnerability feeds —
 * `GET /api/vulnerabilities/mirror`, the row of status lines in the banner
 * a fresh install shows until its database is built.
 *
 * Three feeds, because findings are three things stacked: the OSV mirror
 * says *which* advisories affect a package, EPSS says how likely each is to
 * be exploited and KEV which ones already are, and the Risk Score is a
 * function of all three (ADR 0005). A banner that watched only the OSV
 * bootstrap went quiet the moment findings appeared, while every score on
 * the page was still about to change. Before this the only place to see
 * that EPSS had run, or failed, was the server log.
 *
 * Pure: the three state rows in, the response out, so the status rules are
 * unit-tested without a database. The client mirrors `MirrorStatus` by hand
 * (`client/src/lib/mirror-status.ts`); `scripts/check-cross-app-constants.mjs`
 * holds the two in step.
 */

import type { OsvSyncState, BootstrapProgress } from "../db/schema/osv-mirror.js";
import type { epssSyncState, kevSyncState } from "../db/schema/threat-intel.js";
import { isFeedRunning } from "./feed-health.js";

type EpssState = typeof epssSyncState.$inferSelect;
type KevState = typeof kevSyncState.$inferSelect;

/**
 * Where a feed is on its way to its first successful run.
 *
 * - `pending` — never completed, nothing running, no error: the scheduler has
 *   not reached it. On a fresh install EPSS and KEV sit here while the OSV
 *   bootstrap runs, since the start-up pass runs them after it.
 * - `running` — in progress now.
 * - `failed` — never completed and the last attempt errored; the scheduled
 *   run retries.
 * - `ready` — completed at least once. Staleness after that is the admin
 *   Feeds tab's concern, not the banner's.
 */
export type FeedStatus = "pending" | "running" | "failed" | "ready";

export interface MirrorStatus {
    /** Every feed has completed at least once; the banner has nothing to say. */
    ready: boolean;
    osv: {
        status: FeedStatus;
        initialized: boolean;
        initCompletedAt: string | null;
        lastError: string | null;
        /** What the live generation carries; null is the whole corpus. */
        ecosystems: string[] | null;
        /** The running bootstrap's position; null outside one. */
        bootstrap: BootstrapProgress | null;
        /** Records the bootstrap that built the live generation imported, and how long it ran; null until it is ready. */
        recordsMirrored: number | null;
        bootstrapDurationMs: number | null;
    };
    epss: {
        status: FeedStatus;
        lastSyncedAt: string | null;
        runStartedAt: string | null;
        lastError: string | null;
        /** The feed's own `score_date` of the last successful run. */
        scoreDate: string | null;
        /** CVEs in the file that reached an advisory, on the last successful run. */
        cvesMatched: number | null;
    };
    kev: {
        status: FeedStatus;
        lastSyncedAt: string | null;
        runStartedAt: string | null;
        lastError: string | null;
        catalogVersion: string | null;
        /** Catalogue entries that reached an advisory, on the last successful run. */
        entriesMatched: number | null;
    };
}

function feedStatus(
    state: { lastSyncedAt: Date | null; runStartedAt: Date | null; lastError: string | null } | null,
    now: Date,
): FeedStatus {
    if (!state) return "pending";
    if (state.lastSyncedAt) return "ready";
    if (isFeedRunning(state.runStartedAt, now)) return "running";
    if (state.lastError) return "failed";
    return "pending";
}

function osvStatus(state: OsvSyncState | null): FeedStatus {
    if (!state) return "pending";
    if (state.initialized) return "ready";
    if (state.syncStatus === "full_refresh") return "running";
    if (state.lastError) return "failed";
    return "pending";
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function buildMirrorStatus(
    rows: {
        osv: OsvSyncState | null;
        epss: EpssState | null;
        kev: KevState | null;
        /** The latest successful initialization run, if any. */
        lastBootstrap?: { recordsProcessed: number; durationMs: number } | null;
    },
    now: Date = new Date(),
): MirrorStatus {
    const osv = osvStatus(rows.osv);
    const epss = feedStatus(rows.epss, now);
    const kev = feedStatus(rows.kev, now);
    return {
        ready: osv === "ready" && epss === "ready" && kev === "ready",
        osv: {
            status: osv,
            initialized: rows.osv?.initialized ?? false,
            initCompletedAt: iso(rows.osv?.initCompletedAt),
            lastError: rows.osv?.lastError ?? null,
            ecosystems: rows.osv?.ecosystems ?? null,
            // Only while a bootstrap runs: a snapshot a crashed run left
            // behind, before the next run resets the status, is not progress.
            bootstrap: osv === "running" ? (rows.osv?.bootstrapProgress ?? null) : null,
            // Only once the mirror is live: a run that succeeded before a later
            // rebuild was asked for describes a generation that is no longer there.
            recordsMirrored: osv === "ready" ? (rows.lastBootstrap?.recordsProcessed ?? null) : null,
            bootstrapDurationMs: osv === "ready" ? (rows.lastBootstrap?.durationMs ?? null) : null,
        },
        epss: {
            status: epss,
            lastSyncedAt: iso(rows.epss?.lastSyncedAt),
            runStartedAt: iso(rows.epss?.runStartedAt),
            lastError: rows.epss?.lastError ?? null,
            scoreDate: rows.epss?.lastScoreDate ?? null,
            cvesMatched: rows.epss?.rowsMatched ?? null,
        },
        kev: {
            status: kev,
            lastSyncedAt: iso(rows.kev?.lastSyncedAt),
            runStartedAt: iso(rows.kev?.runStartedAt),
            lastError: rows.kev?.lastError ?? null,
            catalogVersion: rows.kev?.catalogVersion ?? null,
            entriesMatched: rows.kev?.entriesMatched ?? null,
        },
    };
}
