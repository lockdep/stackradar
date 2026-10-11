#!/usr/bin/env node
/**
 * KEV Sync CLI
 *
 * Usage:
 *   pnpm kev-sync --once      Run one sync; no-ops if the catalogue is fresh
 *   pnpm kev-sync --force     Run regardless of freshness
 *   pnpm kev-sync --metrics   Show last sync state
 */

import "dotenv/config";
import { loadConfig } from "./config.js";
import { createKevRepository } from "./repository.js";
import { createKevSyncWorker } from "./worker.js";
import { recordKevListings } from "../services/kev-listing.service.js";
import { runFeedCli } from "../lib/feed-cli.js";
import { isFeedStale } from "../lib/feed-health.js";
import { createLogger } from "../lib/logger.js";

const config = loadConfig();
const repository = createKevRepository();

void runFeedCli({
    name: "KEV",
    log: createLogger("kev-sync:cli"),
    usage: `
CISA KEV Sync — confirmed in-the-wild exploitation, onto the advisory mirror

Usage:
  pnpm kev-sync <command>

Commands:
  --once       Run a single sync cycle (the scheduled path). Skips if the last
               successful run was within KEV_MIN_SYNC_INTERVAL_HOURS.
  --force      Run regardless of freshness.
  --metrics    Show the last sync's state without touching the feed.
  --help       This message.

Environment Variables:
  DATABASE_URL                 PostgreSQL connection string
  KEV_FEED_URL                 Catalogue location (default: cisa.gov)
  KEV_MIN_SYNC_INTERVAL_HOURS  Freshness guard; 0 disables (default: 23)
  KEV_MIN_ENTRIES_TO_APPLY     Refuse a catalogue smaller than this (default: 500)
  KEV_REQUEST_TIMEOUT_MS       Download timeout (default: 30000)
  KEV_MAX_RETRIES              Download retries (default: 3)
  LOG_LEVEL                    Log level (default: info)

Notes:
  This sync is a **full replacement**. Advisories CISA has delisted have their
  KEV columns cleared, because a stale listing pins the risk score at maximum
  forever. That is also why the entry floor exists — for a replacement sync, a
  truncated file is a mass deletion.
`,
    loadState: () => repository.getState(),
    formatMetrics: (state) => {
        const ageHours = (Date.now() - state.lastSyncedAt.getTime()) / 3_600_000;
        return `
KEV Sync State:
  Last synced:     ${state.lastSyncedAt.toISOString()} (${ageHours.toFixed(1)}h ago)${
      isFeedStale(state.lastSyncedAt) ? "  ** STALE **" : ""
  }
  Catalog version: ${state.catalogVersion ?? "unknown"}
  Released:        ${state.releasedAt?.toISOString() ?? "unknown"}
  Entries:         ${state.entriesInCatalog?.toLocaleString() ?? "—"}
  Matched:         ${state.entriesMatched?.toLocaleString() ?? "—"}  (advisories in the mirror)
  Cleared:         ${state.entriesCleared?.toLocaleString() ?? "—"}  (delisted by CISA on the last run)
  Last error:      ${state.lastError ?? "none"}
`;
    },
    // Newly listed advisories fan out as `finding.kev-listed` events for the
    // orgs running them (services/kev-listing.service.ts) — the alert
    // worker's input.
    run: (force) =>
        createKevSyncWorker(config, repository, {
            onNewlyListed: (listed, previous) => recordKevListings(listed, previous),
        }).runOnce({ force }),
    formatSkipped: (result) =>
        result.reason === "locked"
            ? "KEV apply is running in another process — nothing to do here."
            : "KEV catalogue is already fresh — nothing to do.",
    formatResult: (result) =>
        `KEV sync complete: ${result.entriesInCatalog?.toLocaleString()} entries, ` +
        `${result.entriesMatched?.toLocaleString()} matched, ` +
        `${result.advisoriesListed?.toLocaleString()} listed, ` +
        `${result.advisoriesCleared?.toLocaleString()} cleared ` +
        `(catalog ${result.catalogVersion ?? "unknown"}).`,
});
