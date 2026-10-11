/**
 * The admin dashboard's "is the system healthy" reads: platform-wide counts,
 * the worker's queue health, the OSV mirror's state and the three feeds'
 * freshness. Platform-operator view, never tenant-scoped, and never served
 * past `requireAdmin`.
 */

import { count, countDistinct, sql, isNull, isNotNull, desc, asc, eq, and, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isFeedStale, FEED_STALE_AFTER_HOURS } from "../lib/feed-health.js";
import type { JobStatus } from "../db/schema/jobs.js";
import { edition } from "../edition.js";
import { ECOSYSTEMS_ENV_VAR, parseEcosystems } from "../osv-sync/ecosystems.js";

import {
    isActiveAdvisory,
    isWithdrawnAdvisory,
    isActiveAffectedPackage,
    isUnscoredAdvisory,
    IMAGE_STATE_FILTERS,
} from "./admin-helpers.js";

/**
 * The figures that say whether the worker is healthy *now*.
 *
 * `byStatus` cannot: it counts every job ever created, so `completed` grows
 * without bound and drowns the three counts that change. A queue with 400k
 * completed jobs and one pending job three hours old looks identical to a
 * healthy one there. These three do not accumulate — each is either a live
 * measurement or a bounded window.
 */
export interface AdminQueueHealth {
    /**
     * How long the oldest `pending` job has been waiting, in seconds. Null when
     * nothing is pending, which is the healthy steady state — not zero, because
     * zero reads as "a job just arrived".
     *
     * `pending` only: a `scheduled` job waiting for its time is doing exactly what
     * it was asked to, and counting it would make every nightly scan look stuck.
     * Measured with the database clock so it cannot drift from the timestamps it
     * is subtracting.
     */
    oldestPendingAgeSeconds: number | null;
    /**
     * Terminal outcomes in the last 24 hours, keyed on `completed_at` so the
     * window is "what the worker finished", not "what was created".
     *
     * `cancelled` is deliberately absent from both figures: a cancellation is a
     * person's decision, not a worker outcome, and putting it in the denominator
     * would let a burst of cancellations dilute a real failure rate.
     */
    last24h: {
        completed: number;
        failed: number;
    };
    /**
     * Failed jobs that have spent every retry (`retry_count >= max_retries`,
     * the budget `jobRepository.fail` counts down), so nothing will move them
     * without a person. They sit in `byStatus.failed` alongside jobs that
     * still have budget, which is why that number never reads as a call to
     * action.
     */
    stuckAtMaxRetries: number;
}

export interface AdminSystemStats {
    organizations: {
        total: number;
        byPlan: Record<string, number>;
    };
    users: {
        total: number;
    };
    jobs: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        health: AdminQueueHealth;
    };
    vulnerabilities: {
        /** Advisories the matcher can actually work with — withdrawn ones excluded. */
        total: number;
        /** The advisories `total` leaves out, so the mirror size stays legible. */
        withdrawn: number;
        bySeverity: Record<string, number>;
        /**
         * Active advisories carrying no CVSS score.
         *
         * The `unknown` severity bucket is not this number. `unknown` means we could
         * not derive a *level*; this means there is no *score* to derive one from.
         * They diverge in both directions — a GHSA with a `database_specific`
         * severity string but no CVSS vector lands in a named bucket while counting
         * here — and only this one answers "how much of the mirror can be ranked".
         */
        withoutCvssScore: number;
        affectedPackagesTotal: number;
    };
    sboms: {
        total: number;
    };
    components: {
        total: number;
        withVulnerabilities: number;
    };
    /**
     * The `images` table itself, platform-wide and across every tenant.
     *
     * `total` is the only number here that is not reachable from any other
     * surface: every other image figure on the dashboard is scoped to one org's
     * deployments, so an image nobody runs — a cluster-free upload, or the
     * leftovers of a deleted cluster — is invisible to all of them. The gap
     * between `total` and `withSbom` is the ingest backlog, and `orphaned` is
     * what the nightly GC is aiming at.
     */
    images: {
        total: number;
        withSbom: number;
        /** No `workload_containers` row anywhere — a GC candidate once it ages out. */
        orphaned: number;
        /**
         * Running somewhere, with no SBOM — the ingest backlog.
         *
         * Not `total - withSbom`: that difference also swallows the orphaned
         * images nobody runs, which are the GC's problem and not the scanner's.
         */
        awaitingSbom: number;
    };
    /**
     * The Kubernetes inventory, counted once across all tenants.
     *
     * `containers` counts `workload_containers` rows, not distinct images: one
     * digest running in forty places is forty rows here and one row in `images`.
     * The ratio between the two is the whole argument for keying on the digest,
     * which is why both are on the same screen.
     */
    kubernetes: {
        clusters: number;
        namespaces: number;
        workloads: number;
        containers: number;
        helmReleases: number;
    };
}

export interface AdminOsvStatus {
    state: {
        initialized: boolean;
        syncStatus: string;
        lastSuccessfulPollAt: Date | null;
        // Both watermarks, not just the applied one. Applied-age alone conflates
        // "OSV has published nothing for two hours" (healthy) with "we are two
        // hours behind" (not) — the difference between them is the lag.
        lastModifiedSeen: Date | null;
        lastModifiedApplied: Date | null;
        lastFullRefreshAt: Date | null;
        affectedPkgGeneration: number;
        consecutiveFailures: number;
        lastError: string | null;
        updatedAt: Date;
        /**
         * The OSV directories the live generation was built from, or null for
         * the whole corpus (`OSV_ECOSYSTEMS`). What
         * the mirror *contains*; `configuredEcosystems` is what the process
         * wants, and the two differ when the variable changed after the last
         * bootstrap.
         */
        ecosystems: string[] | null;
    } | null;
    /** The process's `OSV_ECOSYSTEMS` as resolved by `osv-sync/ecosystems.ts`; null for everything. */
    configuredEcosystems: string[] | null;
    /**
     * Row counts per generation of `vulnerability_affected_packages`.
     *
     * Normally one entry. Two during a rebuild — the live generation serving
     * reads and the one being built beside it — which is the only progress
     * indicator a multi-hour bootstrap has. A lingering third would mean a
     * previous rebuild died before `discardGeneration()` could clean up after
     * it, which is otherwise invisible and shows up only as a table twice the
     * size it should be.
     */
    generations: Array<{ generation: number; rowCount: number; isCurrent: boolean }>;
    recentRuns: Array<{
        id: string;
        mode: string;
        success: boolean;
        recordsProcessed: number;
        inserted: number;
        updated: number;
        // Real since the upsert started returning `(xmax = 0)`. Previously this and
        // `updated` were both permanently 0, which is why nothing rendered them.
        unchanged: number;
        parseFailures: number;
        durationMs: number;
        lagSeconds: number | null;
        startedAt: Date;
        completedAt: Date;
    }>;
    /**
     * Records the mirror could not take: the advisory is *missing*. Anything
     * above zero here means the mirror has a hole.
     */
    parseFailures: {
        total: number;
        last7Days: number;
        byType: Record<string, number>;
    };
    /**
     * Records that deviated from the OSV JSON schema and were ingested anyway.
     * Not a data-loss signal — mostly upstream publishers violating the spec
     * (openSUSE ships references with no `url`), plus anything our vendored
     * schema is too old to recognise. Kept separate from `parseFailures`
     * because conflating them reported ~25,000 "failures" for a mirror that
     * had lost nothing, which made the real number unwatchable.
     */
    validationWarnings: {
        total: number;
        last7Days: number;
    };
}

/**
 * The three daily feed syncs beside the OSV mirror: EPSS, KEV and Artifact Hub.
 *
 * Each is a single overwritten state row (`threat-intel.ts`, `artifact-hub.ts`)
 * rather than a run history, so this reports the last run and nothing older.
 * A failed run records `lastError` without touching `lastSyncedAt` — the two
 * move independently, and both are surfaced for exactly that reason: fresh data
 * plus an error means "last night's attempt failed, yesterday's data is live".
 *
 * The `stale` flags are computed here with `isFeedStale()` so this endpoint and
 * the `--metrics` CLIs cannot disagree about the threshold; `staleAfterHours`
 * carries the threshold itself so the UI can caption it without duplicating the
 * constant.
 */
export interface AdminFeedsStatus {
    staleAfterHours: number;
    epss: {
        state: {
            lastSyncedAt: Date | null;
            /** The age the data claims (`score_date` from the CSV header), as distinct from when we fetched it. */
            lastScoreDate: string | null;
            rowsInFile: number | null;
            rowsMatched: number | null;
            /** Expected to be tens of thousands — EPSS scores every CVE, the mirror holds only ecosystem advisories. */
            rowsUnmatched: number | null;
            lastError: string | null;
            updatedAt: Date;
        } | null;
        stale: boolean;
        /** Advisories currently carrying a score — what the feed has actually decorated, not what the last run touched. */
        advisoriesWithScore: number;
    };
    kev: {
        state: {
            lastSyncedAt: Date | null;
            catalogVersion: string | null;
            releasedAt: Date | null;
            entriesInCatalog: number | null;
            entriesMatched: number | null;
            /** Advisories whose KEV columns the run cleared because CISA withdrew the CVE. Rare but load-bearing. */
            entriesCleared: number | null;
            lastError: string | null;
            updatedAt: Date;
        } | null;
        stale: boolean;
        advisoriesListed: number;
    };
    artifactHub: {
        state: {
            lastSyncedAt: Date | null;
            packagesInDump: number | null;
            packagesApplied: number | null;
            /** Attribution counters are a separate write after the mirror pass — null until it runs. */
            chartsExamined: number | null;
            attributionsWritten: number | null;
            attributionsRefused: number | null;
            reposAutoAdded: number | null;
            lastError: string | null;
            updatedAt: Date;
        } | null;
        stale: boolean;
        /** Live row counts — what the stamp-and-prune mirror holds now, not what the last run applied. */
        mirrorPackages: number;
        attributions: number;
    };
}

/**
 * The three queue-health queries, run together.
 *
 * Split out of `getSystemStats` because `getVulnerabilityStats` has no use for
 * them and a future Jobs-tab caller will.
 */
async function queueHealth(): Promise<AdminQueueHealth> {
    const [oldestRow, outcomeRows, stuckRow] = await Promise.all([
        // now() rather than a JS timestamp: the age is a difference between two
        // database clocks, and mixing in the app's would make it drift.
        db
            .select({
                ageSeconds: sql<string | null>`extract(epoch from now() - min(${schema.jobs.createdAt}))`,
            })
            .from(schema.jobs)
            .where(eq(schema.jobs.status, "pending")),

        // Served by jobs_completed_at_idx, which is partial on exactly the terminal
        // statuses this filters to.
        db
            .select({ status: schema.jobs.status, total: count() })
            .from(schema.jobs)
            .where(
                and(
                    inArray(schema.jobs.status, ["completed", "failed"] as JobStatus[]),
                    sql`${schema.jobs.completedAt} > now() - interval '24 hours'`,
                ),
            )
            .groupBy(schema.jobs.status),

        db
            .select({ total: count() })
            .from(schema.jobs)
            .where(and(eq(schema.jobs.status, "failed"), sql`${schema.jobs.retryCount} >= ${schema.jobs.maxRetries}`)),
    ]);

    const byStatus = new Map(outcomeRows.map((r) => [r.status, Number(r.total)]));

    // extract(epoch ...) is numeric, which node-postgres hands back as a string;
    // an aggregate over no rows is null, and null is the answer we want.
    const rawAge = oldestRow[0]?.ageSeconds;

    return {
        oldestPendingAgeSeconds: rawAge === null || rawAge === undefined ? null : Math.floor(Number(rawAge)),
        last24h: {
            completed: byStatus.get("completed") ?? 0,
            failed: byStatus.get("failed") ?? 0,
        },
        stuckAtMaxRetries: Number(stuckRow[0]?.total ?? 0),
    };
}

export const adminStatusRepository = {
    async getSystemStats(): Promise<AdminSystemStats> {
        const [
            orgRows,
            planRows,
            userRow,
            jobCountRows,
            jobStatusRows,
            jobTypeRows,
            jobHealth,
            vulnCountRow,
            withdrawnVulnRow,
            unscoredVulnRow,
            vulnSeverityRows,
            affectedPkgRow,
            sbomRow,
            componentRow,
            componentVulnRow,
            imageRow,
            orphanedImageRow,
            awaitingSbomImageRow,
            clusterRow,
            namespaceRow,
            workloadRow,
            containerRow,
            helmReleaseRow,
        ] = await Promise.all([
            db.select({ total: count() }).from(schema.organizations).where(isNull(schema.organizations.deletedAt)),

            db
                .select({ plan: schema.organizations.plan, total: count() })
                .from(schema.organizations)
                .where(isNull(schema.organizations.deletedAt))
                .groupBy(schema.organizations.plan),

            db.select({ total: countDistinct(schema.users.id) }).from(schema.users),

            db.select({ total: count() }).from(schema.jobs),

            db.select({ status: schema.jobs.status, total: count() }).from(schema.jobs).groupBy(schema.jobs.status),

            db.select({ type: schema.jobs.type, total: count() }).from(schema.jobs).groupBy(schema.jobs.type),

            queueHealth(),

            db.select({ total: count() }).from(schema.vulnerabilities).where(isActiveAdvisory()),

            db.select({ total: count() }).from(schema.vulnerabilities).where(isWithdrawnAdvisory()),

            db.select({ total: count() }).from(schema.vulnerabilities).where(isUnscoredAdvisory()),

            db
                .select({ level: schema.vulnerabilities.severityLevel, total: count() })
                .from(schema.vulnerabilities)
                .where(isActiveAdvisory())
                .groupBy(schema.vulnerabilities.severityLevel),

            db.select({ total: count() }).from(schema.vulnerabilityAffectedPackages).where(isActiveAffectedPackage()),

            db.select({ total: count() }).from(schema.sboms),

            db.select({ total: count() }).from(schema.components),

            db
                .select({ total: countDistinct(schema.componentVulnerabilities.componentId) })
                .from(schema.componentVulnerabilities),

            db.select({ total: count() }).from(schema.images),

            // The GC's first condition, without the age one: how many images are
            // unreferenced *now*. Not how many the next sweep will collect —
            // `last_seen_at` has to be older than the retention window for that,
            // and this deliberately counts the ones still inside it too, because
            // that population is the early warning the log line cannot give.
            db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.orphaned),

            db.select({ total: count() }).from(schema.images).where(IMAGE_STATE_FILTERS.awaiting_sbom),

            db.select({ total: count() }).from(schema.clusters),
            db.select({ total: count() }).from(schema.namespaces),
            db.select({ total: count() }).from(schema.workloads),
            db.select({ total: count() }).from(schema.workloadContainers),
            db.select({ total: count() }).from(schema.helmReleases),
        ]);

        const byPlan: Record<string, number> = {};
        for (const row of planRows) {
            byPlan[row.plan] = Number(row.total);
        }

        const byStatus: Record<string, number> = {};
        for (const row of jobStatusRows) {
            byStatus[row.status] = Number(row.total);
        }

        const byType: Record<string, number> = {};
        for (const row of jobTypeRows) {
            byType[row.type] = Number(row.total);
        }

        const bySeverity: Record<string, number> = {};
        for (const row of vulnSeverityRows) {
            bySeverity[row.level ?? "unknown"] = Number(row.total);
        }

        return {
            organizations: {
                total: Number(orgRows[0]?.total ?? 0),
                byPlan,
            },
            users: {
                total: Number(userRow[0]?.total ?? 0),
            },
            jobs: {
                total: Number(jobCountRows[0]?.total ?? 0),
                byStatus,
                byType,
                health: jobHealth,
            },
            vulnerabilities: {
                total: Number(vulnCountRow[0]?.total ?? 0),
                withdrawn: Number(withdrawnVulnRow[0]?.total ?? 0),
                bySeverity,
                withoutCvssScore: Number(unscoredVulnRow[0]?.total ?? 0),
                affectedPackagesTotal: Number(affectedPkgRow[0]?.total ?? 0),
            },
            sboms: {
                total: Number(sbomRow[0]?.total ?? 0),
            },
            components: {
                total: Number(componentRow[0]?.total ?? 0),
                withVulnerabilities: Number(componentVulnRow[0]?.total ?? 0),
            },
            images: {
                total: Number(imageRow[0]?.total ?? 0),
                // `sboms_image_id_unique` makes one SBOM one image, so the SBOM count
                // *is* the count of images carrying one. No second query, and no way
                // for the two figures to disagree.
                withSbom: Number(sbomRow[0]?.total ?? 0),
                orphaned: Number(orphanedImageRow[0]?.total ?? 0),
                awaitingSbom: Number(awaitingSbomImageRow[0]?.total ?? 0),
            },
            kubernetes: {
                clusters: Number(clusterRow[0]?.total ?? 0),
                namespaces: Number(namespaceRow[0]?.total ?? 0),
                workloads: Number(workloadRow[0]?.total ?? 0),
                containers: Number(containerRow[0]?.total ?? 0),
                helmReleases: Number(helmReleaseRow[0]?.total ?? 0),
            },
        };
    },

    async getOsvStatus(): Promise<AdminOsvStatus> {
        const [stateRows, recentRuns, failuresByType, generationRows] = await Promise.all([
            db.select().from(schema.osvSyncState).limit(1),
            db.select().from(schema.osvSyncRuns).orderBy(desc(schema.osvSyncRuns.completedAt)).limit(10),
            // One grouped pass rather than a total/recent/by-type trio: the splits
            // below are all derivable from it, and it is the same index scan.
            db
                .select({
                    errorType: schema.osvSyncFailures.errorType,
                    total: count(),
                    last7Days: sql<string>`count(*) filter (
            where ${schema.osvSyncFailures.occurredAt} > now() - interval '7 days'
          )`,
                })
                .from(schema.osvSyncFailures)
                .groupBy(schema.osvSyncFailures.errorType),
            // Unscoped by generation on purpose — the one query in the codebase that
            // is. Every other reader must call isCurrentGeneration(); this one exists
            // precisely to show what the others are hiding: a rebuild's progress, or
            // rows orphaned by one that died. Grouping on the indexed generation
            // column keeps it to an index-only scan, and this is an admin page.
            db
                .select({
                    generation: schema.vulnerabilityAffectedPackages.generation,
                    total: count(),
                })
                .from(schema.vulnerabilityAffectedPackages)
                .groupBy(schema.vulnerabilityAffectedPackages.generation)
                .orderBy(asc(schema.vulnerabilityAffectedPackages.generation)),
        ]);

        const state = stateRows[0] ?? null;

        // `validation_warning` rows describe records that were ingested; every
        // other error type describes one that was not. Splitting on that here is
        // what keeps a schema deviation from reading as a lost advisory.
        const byType: Record<string, number> = {};
        const failed = { total: 0, last7Days: 0 };
        const warned = { total: 0, last7Days: 0 };
        for (const row of failuresByType) {
            const total = Number(row.total);
            const last7Days = Number(row.last7Days);
            const bucket = row.errorType === "validation_warning" ? warned : failed;
            bucket.total += total;
            bucket.last7Days += last7Days;
            if (bucket === failed) byType[row.errorType] = total;
        }

        // Falls back to the column default rather than to "nothing is current" when
        // the state row is missing, matching currentGeneration()'s COALESCE — so a
        // fresh database shows generation 1 as live instead of flagging every row
        // as orphaned.
        const currentGen = state?.affectedPkgGeneration ?? 1;

        return {
            state: state
                ? {
                      initialized: state.initialized,
                      syncStatus: state.syncStatus,
                      lastSuccessfulPollAt: state.lastSuccessfulPollAt,
                      lastModifiedSeen: state.lastModifiedSeen,
                      lastModifiedApplied: state.lastModifiedApplied,
                      lastFullRefreshAt: state.lastFullRefreshAt,
                      affectedPkgGeneration: state.affectedPkgGeneration,
                      consecutiveFailures: state.consecutiveFailures,
                      lastError: state.lastError,
                      updatedAt: state.updatedAt,
                      ecosystems: state.ecosystems ?? null,
                  }
                : null,
            configuredEcosystems: parseEcosystems(process.env[ECOSYSTEMS_ENV_VAR], edition),
            generations: generationRows.map((g) => ({
                generation: g.generation,
                rowCount: Number(g.total),
                isCurrent: g.generation === currentGen,
            })),
            recentRuns: recentRuns.map((r) => ({
                id: r.id,
                mode: r.mode,
                success: r.success,
                recordsProcessed: r.recordsProcessed,
                inserted: r.inserted,
                updated: r.updated,
                unchanged: r.unchanged,
                parseFailures: r.parseFailures,
                durationMs: r.durationMs,
                lagSeconds: r.lagSeconds,
                startedAt: r.startedAt,
                completedAt: r.completedAt,
            })),
            parseFailures: { ...failed, byType },
            validationWarnings: warned,
        };
    },

    async getFeedsStatus(): Promise<AdminFeedsStatus> {
        const [epssRows, kevRows, ahRows, epssScoredRow, kevListedRow, ahPackagesRow, attributionsRow] =
            await Promise.all([
                db.select().from(schema.epssSyncState).limit(1),
                db.select().from(schema.kevSyncState).limit(1),
                db.select().from(schema.artifactHubSyncState).limit(1),
                db
                    .select({ total: count() })
                    .from(schema.vulnerabilities)
                    .where(isNotNull(schema.vulnerabilities.epssScore)),
                db
                    .select({ total: count() })
                    .from(schema.vulnerabilities)
                    .where(isNotNull(schema.vulnerabilities.kevListedAt)),
                db.select({ total: count() }).from(schema.artifactHubPackages),
                db.select({ total: count() }).from(schema.chartAttributions),
            ]);

        const epss = epssRows[0] ?? null;
        const kev = kevRows[0] ?? null;
        const ah = ahRows[0] ?? null;

        return {
            staleAfterHours: FEED_STALE_AFTER_HOURS,
            epss: {
                state: epss
                    ? {
                          lastSyncedAt: epss.lastSyncedAt,
                          lastScoreDate: epss.lastScoreDate,
                          rowsInFile: epss.rowsInFile,
                          rowsMatched: epss.rowsMatched,
                          rowsUnmatched: epss.rowsUnmatched,
                          lastError: epss.lastError,
                          updatedAt: epss.updatedAt,
                      }
                    : null,
                stale: isFeedStale(epss?.lastSyncedAt),
                advisoriesWithScore: Number(epssScoredRow[0]?.total ?? 0),
            },
            kev: {
                state: kev
                    ? {
                          lastSyncedAt: kev.lastSyncedAt,
                          catalogVersion: kev.catalogVersion,
                          releasedAt: kev.releasedAt,
                          entriesInCatalog: kev.entriesInCatalog,
                          entriesMatched: kev.entriesMatched,
                          entriesCleared: kev.entriesCleared,
                          lastError: kev.lastError,
                          updatedAt: kev.updatedAt,
                      }
                    : null,
                stale: isFeedStale(kev?.lastSyncedAt),
                advisoriesListed: Number(kevListedRow[0]?.total ?? 0),
            },
            artifactHub: {
                state: ah
                    ? {
                          lastSyncedAt: ah.lastSyncedAt,
                          packagesInDump: ah.packagesInDump,
                          packagesApplied: ah.packagesApplied,
                          chartsExamined: ah.chartsExamined,
                          attributionsWritten: ah.attributionsWritten,
                          attributionsRefused: ah.attributionsRefused,
                          reposAutoAdded: ah.reposAutoAdded,
                          lastError: ah.lastError,
                          updatedAt: ah.updatedAt,
                      }
                    : null,
                stale: isFeedStale(ah?.lastSyncedAt),
                mirrorPackages: Number(ahPackagesRow[0]?.total ?? 0),
                attributions: Number(attributionsRow[0]?.total ?? 0),
            },
        };
    },

    async getOsvState() {
        const [state] = await db.select().from(schema.osvSyncState).limit(1);
        return state ?? null;
    },
};
