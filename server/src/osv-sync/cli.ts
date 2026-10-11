#!/usr/bin/env node
/**
 * OSV Sync CLI
 *
 * Command-line interface for the OSV vulnerability mirror sync worker.
 *
 * Usage:
 *   pnpm osv-sync --once                Run one incremental cycle; refuses to bootstrap
 *   pnpm osv-sync --full-refresh        Bootstrap or rebuild from all.zip (one-shot)
 *   pnpm osv-sync --bootstrap-if-needed Bootstrap only if the mirror is empty
 *   pnpm osv-sync --metrics             Show current sync metrics
 *   pnpm osv-sync --fill-severity       Re-lend severities across the whole mirror
 */

import "dotenv/config";
import type { SyncCycleResult } from "./worker.js";
import { createOsvSyncRuntime } from "./runtime.js";
import { fillInheritedSeverity } from "./severity-fill.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:cli");

/**
 * Log one run's outcome: info for success or a benign lock-held skip, error
 * otherwise. `withModeAndLag` adds the fields only the scheduled incremental
 * path reports — the mode (a cycle can be either) and the post-run lag.
 */
function reportRun(
    result: SyncCycleResult,
    message: string,
    { withModeAndLag = false }: { withModeAndLag?: boolean } = {},
): void {
    const logFn = result.success || result.skipped ? log.info.bind(log) : log.error.bind(log);
    logFn(
        {
            syncRunId: result.syncRunId,
            ...(withModeAndLag && { mode: result.mode }),
            success: result.success,
            ...(result.skipped && { skipped: true }),
            recordsProcessed: result.recordsProcessed,
            inserted: result.inserted,
            updated: result.updated,
            unchanged: result.unchanged,
            affectedPackagesExtracted: result.affectedPackagesExtracted,
            schemaValidationWarnings: result.schemaValidationWarnings,
            parseFailures: result.parseFailures,
            durationMs: result.durationMs,
            ...(withModeAndLag && result.lagSeconds !== undefined && { lagSeconds: result.lagSeconds }),
            ...(result.errors.length > 0 && { errors: result.errors.slice(0, 10), errorCount: result.errors.length }),
        },
        message,
    );
}

function printUsage(): void {
    console.log(`
OSV Vulnerability Mirror Sync

Usage:
  pnpm osv-sync <command>

Commands:
  --once               Run a single incremental sync cycle (the scheduled path).
                       Fails if the mirror has never been bootstrapped — it will
                       not start a full rebuild.
  --full-refresh       Bootstrap or rebuild the mirror: from all.zip, or from
                       one archive per ecosystem when OSV_ECOSYSTEMS is set.
                       One-shot, unresumable, and the route to a deliberate
                       rebuild of a mirror that already works.
                       Matching keeps serving the previous data throughout.
  --bootstrap-if-needed
                       Run --full-refresh only if the mirror has never completed
                       a generation, or was built with a narrower OSV_ECOSYSTEMS
                       than is now configured; exit 0 immediately otherwise. The
                       scheduled recovery path — give it its own CronJob with a
                       deadline sized for a full rebuild, never the hourly --once
                       one. The monolith runs it at start-up and twice a day.
  --metrics            Show current sync metrics
  --fill-severity      Give every advisory that publishes no severity the score
                       of a scored record of the same CVE, across the whole
                       mirror (severity-fill.ts). The sync does this itself for
                       what it touches; this is the one-off backfill.
  --help               Show this help message

Environment Variables:
  DATABASE_URL                     PostgreSQL connection string
  OSV_ECOSYSTEMS                   Comma-separated OSV directory names the mirror
                                   carries (case-sensitive: "Alpine,Debian,Red Hat").
                                   Unset: the community edition's default list, or
                                   everything on the cloud. "*" means everything.
  OSV_OVERLAP_WINDOW_MINUTES       Overlap window for incremental sync (default: 10)
  OSV_MAX_PARALLEL_DOWNLOADS       Max concurrent downloads (default: 8)
  OSV_BATCH_SIZE                   DB batch size (default: 100)
  OSV_BULK_FALLBACK_THRESHOLD      Candidates above which a run pulls per-ecosystem
                                   archives instead of per-record GETs (default: 5000)
  OSV_LAG_WARNING_THRESHOLD_HOURS  Lag warning threshold (default: 6)
  OSV_FAILURE_RETENTION_DAYS       Days of osv_sync_failures kept; 0 disables (default: 30)
  OSV_REQUEST_TIMEOUT_MS           Per-request timeout, headers and body (default: 30000)
  OSV_STREAM_STALL_TIMEOUT_MS      Abort a streamed body after this long with no
                                   bytes (default: 60000)
  OSV_USER_AGENT                   HTTP User-Agent string
  LOG_LEVEL                        Log level (default: info)

Examples:
  # Bootstrap a fresh mirror (run once, by hand or as a one-shot Job)
  pnpm osv-sync --full-refresh

  # Self-healing bootstrap (use with a slow CronJob; no-op once initialized)
  pnpm osv-sync --bootstrap-if-needed

  # Keep it current (use with cron/CronJob)
  pnpm osv-sync --once

  # Check sync status
  pnpm osv-sync --metrics
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(0);
    }

    const command = args[0];

    if (!["--once", "--full-refresh", "--bootstrap-if-needed", "--metrics", "--fill-severity"].includes(command!)) {
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }

    const runtime = createOsvSyncRuntime();
    const { config, worker, stateManager, affectedPkgRepository } = runtime;

    log.info(
        {
            databaseUrl: config.databaseUrl.replace(/:[^:@]+@/, ":***@"),
            ecosystems: config.ecosystems ?? "all",
            overlapWindowMinutes: config.overlapWindowMinutes,
            maxParallelDownloads: config.maxParallelDownloads,
            batchSize: config.batchSize,
        },
        "Configuration loaded",
    );

    let exitCode = 0;

    try {
        switch (command) {
            case "--once": {
                log.info("Running single sync cycle");
                const result = await worker.runCycle();

                reportRun(result, "Sync result", { withModeAndLag: true });

                // A skipped run exits 0: another instance holds the lock, which
                // is an overlap, not an error, and a non-zero exit here spends
                // the Job's backoffLimit and alerts on nothing.
                exitCode = result.success || result.skipped ? 0 : 1;
                break;
            }

            case "--full-refresh": {
                log.info("Starting forced full refresh");
                const result = await worker.forceFullRefresh();

                reportRun(result, "Full refresh result");

                exitCode = result.success || result.skipped ? 0 : 1;
                break;
            }

            case "--bootstrap-if-needed": {
                log.info("Checking whether the mirror needs a bootstrap");
                const result = await worker.bootstrapIfNeeded();

                // The expected outcome on every run but the first. Logged at
                // info with no run stats, because a no-op has none — and
                // because this fires twice a day forever, so it must not look
                // like an event.
                if (result.noop) {
                    log.info("Mirror already initialized — no bootstrap needed");
                    exitCode = 0;
                    break;
                }

                reportRun(result, "Bootstrap-if-needed result");

                exitCode = result.success || result.skipped ? 0 : 1;
                break;
            }

            case "--fill-severity": {
                const updated = await fillInheritedSeverity("all");
                console.log(`Severity fill: ${updated.toLocaleString()} advisory records updated`);
                break;
            }

            case "--metrics": {
                await stateManager.ensureInitialized();

                const metrics = await worker.getMetrics();
                const affectedPkgCount = await affectedPkgRepository.getCount();
                const state = await stateManager.getState();

                console.log("\nOSV Sync Metrics:");
                console.log(`  Initialized: ${metrics.initialized}`);
                console.log(`  Ecosystems (mirror): ${state.ecosystems ? state.ecosystems.join(", ") : "all"}`);
                console.log(`  Ecosystems (configured): ${config.ecosystems ? config.ecosystems.join(", ") : "all"}`);
                console.log(`  Total vulnerability records (estimate): ${metrics.totalRecords.toLocaleString()}`);
                console.log(`  Total affected package rows: ${affectedPkgCount.toLocaleString()}`);

                if (metrics.lagSeconds !== null) {
                    const hours = Math.floor(metrics.lagSeconds / 3600);
                    const minutes = Math.floor((metrics.lagSeconds % 3600) / 60);
                    console.log(`  Lag: ${hours}h ${minutes}m (${metrics.lagSeconds}s)`);
                } else {
                    console.log("  Lag: N/A");
                }

                console.log(`  Consecutive failures: ${metrics.consecutiveFailures}`);

                if (metrics.lastError) {
                    console.log(`  Last error: ${metrics.lastError}`);
                }

                break;
            }
        }
    } catch (error) {
        log.error({ error }, "CLI error");
        console.error("Error:", error instanceof Error ? error.message : String(error));
        exitCode = 1;
    } finally {
        await runtime.close();
    }

    process.exit(exitCode);
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
