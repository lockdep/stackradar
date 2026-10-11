// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * Types for the cloud's admin tabs: the feedback inbox and the public chart
 * index's operator view. Both describe hosted-only data — a community install
 * has neither a feedback table worth an inbox nor a chart index — so they live
 * with the tabs rather than in `views/admin/types.ts`.
 */

// ── Feedback ─────────────────────────────────────────────────────────────────

/** One `feedback` row with its author (and their active org) joined on. */
export interface AdminFeedbackEntry {
    id: string;
    message: string;
    /** In-app path the dialog was opened from; null when the client didn't send one. */
    page: string | null;
    createdAt: string;
    userId: string;
    userName: string | null;
    userEmail: string;
    orgId: string | null;
    /** Null when no org context was recorded or the org has been deleted. */
    orgName: string | null;
}

export interface AdminFeedbackData {
    feedback: AdminFeedbackEntry[];
    total: number;
    limit: number;
    offset: number;
}

// ── Chart Index ──────────────────────────────────────────────────────────────
//
// The payload of the chart index site's `GET /internal/status`, which
// `/api/admin/chart-index` relays. Copied in shape rather than imported: the
// chart index is its own repository and the two share no package. That site
// is the definition; a field added there is a field added here.

export type ChartIndexTask = 'select' | 'render' | 'prune' | 'inventory' | 'match' | 'score' | 'trending';

export interface ChartIndexRunSync {
    osvSyncedAt: string | null;
    epssScoreDate: string | null;
    kevCatalogVersion: string | null;
}

export interface ChartIndexRun {
    id: string;
    task: ChartIndexTask;
    startedAt: string;
    /** Null while in flight — or after a crash that never finalised the row. */
    finishedAt: string | null;
    /** Null until finished. */
    ok: boolean | null;
    error: string | null;
    stats: Record<string, unknown>;
    helmVersion: string | null;
    syftVersion: string | null;
    serverVersion: string | null;
    sync: ChartIndexRunSync | null;
    durationMs: number | null;
}

export interface ChartIndexTaskStatus {
    task: ChartIndexTask;
    lastRun: ChartIndexRun | null;
    lastOkAt: string | null;
    /** Runs started in the last 24 hours; for inventory, scanner batches. */
    last24h: { ok: number; failed: number; unfinished: number };
}

export interface ChartIndexSchedule {
    name: 'pipeline' | 'daily' | 'trending';
    tasks: ChartIndexTask[];
    cron: string;
    nextAt: string | null;
}

export interface ChartIndexReason {
    reason: string;
    count: number;
}

export interface ChartIndexStatus {
    generatedAt: string;
    schedules: ChartIndexSchedule[];
    tasks: ChartIndexTaskStatus[];
    recentRuns: ChartIndexRun[];
    freshness: {
        scoredAt: string;
        sync: ChartIndexRunSync | null;
        helmVersion: string | null;
        syftVersion: string | null;
        serverVersion: string | null;
    } | null;
    catalogue: {
        charts: {
            total: number;
            selected: number;
            selectedWithLatest: number;
            official: number;
            repoVerified: number;
            lastSeenAt: string | null;
        };
        versions: {
            total: number;
            byRenderStatus: { pending: number; rendered: number; failed: number };
            live: { total: number; pending: number; rendered: number; failed: number; noTarball: number };
            attempted24h: number;
            rendered24h: number;
            appVersionCheck: { matched: number; unmatched: number; unknown: number; unchecked: number };
        };
        renderFailures: ChartIndexReason[];
        repoIndexCache: { repositories: number; fetched24h: number; oldestFetchedAt: string | null };
        workloads: { total: number; resolved: number; unresolved: number };
        resolutionErrors: ChartIndexReason[];
    };
    images: {
        byStatus: { pending: number; done: number; failed: number; retired: number };
        inFlight: Array<{
            claimedBy: string | null;
            claimedAt: string;
            ageSeconds: number;
            registry: string;
            repository: string;
            digest: string;
            attempts: number;
        }>;
        staleClaims: number;
        queueByRegistry: Array<{ registry: string; count: number; topPriority: number }>;
        failedByAttempts: Array<{ attempts: number; count: number }>;
        maxAttempts: number;
        failures: ChartIndexReason[];
        done24h: number;
        failed24h: number;
        oldestPendingAt: string | null;
        sboms: { total: number; components: number; latestGeneratedAt: string | null };
        scanned: number;
        doneUnscanned: number;
        currentFindings: { total: number; kev: number; exploited: number };
    };
    scores: {
        liveVersions: { total: number; scored: number; images: number; measured: number; lastScoredAt: string | null };
        samples: { today: number; latestSampledOn: string | null };
        deltas: number;
        deployedImages: { total: number; scored: number };
        trending: { rows: number; computedAt: string | null };
        advisoryReach: { rows: number; computedAt: string | null };
    };
    database: {
        name: string | null;
        sizeBytes: number | null;
        tables: Array<{ name: string; rows: number; bytes: number }>;
    };
}
