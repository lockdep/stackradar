/**
 * The shared shell of the feed-sync CLIs (epss-sync, kev-sync,
 * artifacthub-sync): `--once` / `--force` / `--metrics` / `--help`, exit 0 on
 * success or skip, 1 on failure or misuse. The CLIs differ only in their
 * usage text, how their state block is formatted, and what a finished run
 * says — everything a `FeedCliSpec` carries.
 *
 * osv-sync's CLI is deliberately not this: it has four commands, refuses to
 * bootstrap from the hourly path, and maps lock-skips to their own exit
 * semantics. See `osv-sync/cli.ts`.
 */

import type { Logger } from "pino";

export interface FeedCliSpec<TState extends { lastSyncedAt: Date | null }, TResult extends { skipped: boolean }> {
    /** Names the feed in headers and error logs: "EPSS", "KEV", "Artifact Hub". */
    name: string;
    log: Logger;
    /** The full `--help` text, printed as-is. */
    usage: string;
    /** The single-row sync state, for `--metrics`. */
    loadState: () => Promise<TState | undefined>;
    /** The `--metrics` block for a state that has synced at least once. */
    formatMetrics: (state: TState & { lastSyncedAt: Date }) => string;
    /** One sync cycle; `force` bypasses the freshness guard. */
    run: (force: boolean) => Promise<TResult>;
    /** The console line for a skipped run. */
    formatSkipped: (result: TResult) => string;
    /** The console line for a completed run. */
    formatResult: (result: TResult) => string;
}

export async function runFeedCli<TState extends { lastSyncedAt: Date | null }, TResult extends { skipped: boolean }>(
    spec: FeedCliSpec<TState, TResult>,
): Promise<void> {
    const command = process.argv[2];

    if (!command || command === "--help" || command === "-h") {
        console.log(spec.usage);
        process.exit(command ? 0 : 1);
    }

    if (command === "--metrics") {
        const state = await spec.loadState();
        if (!state?.lastSyncedAt) {
            console.log(`${spec.name} Sync State:\n  Never synced.`);
            process.exit(0);
        }
        console.log(spec.formatMetrics(state as TState & { lastSyncedAt: Date }));
        process.exit(0);
    }

    if (command !== "--once" && command !== "--force") {
        console.error(`Unknown command: ${command}`);
        console.log(spec.usage);
        process.exit(1);
    }

    try {
        const result = await spec.run(command === "--force");
        console.log(result.skipped ? spec.formatSkipped(result) : spec.formatResult(result));
        process.exit(0);
    } catch (err) {
        spec.log.error({ err }, `${spec.name} sync failed`);
        process.exit(1);
    }
}
