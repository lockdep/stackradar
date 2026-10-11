#!/usr/bin/env node
/**
 * EPSS Sync CLI
 *
 * Usage:
 *   pnpm epss-sync --once      Run one sync; no-ops if scores are already fresh
 *   pnpm epss-sync --force     Run even if fresh (re-download and re-apply)
 *   pnpm epss-sync --metrics   Show last sync state
 */

import "dotenv/config";
import { loadConfig } from "./config.js";
import { createEpssDownloader } from "./downloader.js";
import { createEpssRepository } from "./repository.js";
import { createEpssSyncWorker } from "./worker.js";
import { runFeedCli } from "../lib/feed-cli.js";
import { isFeedStale } from "../lib/feed-health.js";
import { createLogger } from "../lib/logger.js";

const config = loadConfig();
const repository = createEpssRepository();

void runFeedCli({
    name: "EPSS",
    log: createLogger("epss-sync:cli"),
    usage: `
EPSS Score Sync — FIRST.org exploitation probabilities, onto the advisory mirror

Usage:
  pnpm epss-sync <command>

Commands:
  --once       Run a single sync cycle (the scheduled path). Skips if the last
               successful run was within EPSS_MIN_SYNC_INTERVAL_HOURS, so it is
               safe to trigger by hand at any time.
  --force      Run regardless of freshness. For recovering from a bad apply.
  --metrics    Show the last sync's state without touching the feed.
  --help       This message.

Environment Variables:
  DATABASE_URL                  PostgreSQL connection string
  EPSS_FEED_URL                 Feed location (default: FIRST.org current scores)
  EPSS_STAGING_BATCH_SIZE       Rows per staging INSERT (default: 5000)
  EPSS_MIN_SYNC_INTERVAL_HOURS  Freshness guard; 0 disables (default: 23)
  EPSS_MIN_ROWS_TO_APPLY        Refuse a file shorter than this (default: 150000)
  EPSS_REQUEST_TIMEOUT_MS       Download timeout (default: 60000)
  EPSS_MAX_RETRIES              Download retries (default: 3)
  LOG_LEVEL                     Log level (default: info)

Notes:
  Scores land on \`vulnerabilities.epss_score\` / \`epss_percentile\`, matched by
  CVE id or by CVE alias. \`vulnerabilities.risk_score\` is a generated column
  over them, so it re-derives itself as this commits — there is no second pass.
`,
    loadState: () => repository.getState(),
    formatMetrics: (state) => {
        const ageHours = (Date.now() - state.lastSyncedAt.getTime()) / 3_600_000;
        return `
EPSS Sync State:
  Last synced:    ${state.lastSyncedAt.toISOString()} (${ageHours.toFixed(1)}h ago)${
      isFeedStale(state.lastSyncedAt) ? "  ** STALE **" : ""
  }
  Score date:     ${state.lastScoreDate ?? "unknown"}
  Rows in file:   ${state.rowsInFile?.toLocaleString() ?? "—"}
  CVEs matched:   ${state.rowsMatched?.toLocaleString() ?? "—"}
  CVEs unmatched: ${state.rowsUnmatched?.toLocaleString() ?? "—"}  (not in the mirror — expected)
  Last error:     ${state.lastError ?? "none"}
`;
    },
    run: (force) => createEpssSyncWorker(config, createEpssDownloader(config), repository).runOnce({ force }),
    formatSkipped: (result) =>
        result.reason === "locked"
            ? "EPSS apply is running in another process — nothing to do here."
            : "EPSS scores are already fresh — nothing to do.",
    formatResult: (result) =>
        `EPSS sync complete: ${result.rowsInFile?.toLocaleString()} rows, ` +
        `${result.cvesMatched?.toLocaleString()} CVEs matched, ` +
        `${result.advisoriesUpdated?.toLocaleString()} advisories re-scored ` +
        `(score date ${result.scoreDate ?? "unknown"}).`,
});
