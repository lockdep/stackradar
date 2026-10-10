#!/usr/bin/env node
/**
 * Artifact Hub Sync CLI
 *
 * Usage:
 *   pnpm artifacthub-sync --once      Run one sync; no-ops if the mirror is already fresh
 *   pnpm artifacthub-sync --force     Run even if fresh (re-download and re-apply)
 *   pnpm artifacthub-sync --metrics   Show last sync state
 */

import "dotenv/config";
import { integrations } from "../config/index.js";
import { loadConfig } from "./config.js";
import { createArtifactHubDownloader } from "./downloader.js";
import { createArtifactHubSyncRepository } from "./repository.js";
import { createArtifactHubSyncWorker } from "./worker.js";
import { runFeedCli } from "../lib/feed-cli.js";
import { isFeedStale } from "../lib/feed-health.js";
import { createLogger } from "../lib/logger.js";

// Switched off (`ARTIFACT_HUB_SYNC_ENABLED=false`): the scheduled run is a
// successful no-op, so a CronJob or the monolith scheduler sees exit 0 and
// a line saying why, not a failure to page on.
if (!integrations.artifactHubSync && (process.argv[2] === "--once" || process.argv[2] === "--force")) {
    createLogger("artifacthub-sync:cli").info("ARTIFACT_HUB_SYNC_ENABLED=false: Artifact Hub sync is switched off, nothing to do");
    process.exit(0);
}

const config = loadConfig();
const repository = createArtifactHubSyncRepository();

void runFeedCli({
    name: "Artifact Hub",
    log: createLogger("artifacthub-sync:cli"),
    usage: `
Artifact Hub Sync — mirror of the /api/v1/nova dump, for chart attribution

Usage:
  pnpm artifacthub-sync <command>

Commands:
  --once       Run a single sync cycle (the scheduled path). Skips if the last
               successful run was within ARTIFACT_HUB_MIN_SYNC_INTERVAL_HOURS,
               so it is safe to trigger by hand at any time.
  --force      Run regardless of freshness. For recovering from a bad apply.
  --metrics    Show the last sync's state without touching the feed.
  --help       This message.

Environment Variables:
  DATABASE_URL                          PostgreSQL connection string
  ARTIFACT_HUB_FEED_URL                 Dump location; file:// URLs work for a
                                        local dump (default: artifacthub.io/api/v1/nova)
  ARTIFACT_HUB_MIN_SYNC_INTERVAL_HOURS  Freshness guard; 0 disables (default: 23)
  ARTIFACT_HUB_MIN_PACKAGES_TO_APPLY    Refuse a dump shorter than this (default: 10000)
  ARTIFACT_HUB_MAX_BODY_BYTES           Byte ceiling on the dump (default: 104857600)
  ARTIFACT_HUB_STAGING_BATCH_SIZE       Rows per upsert statement (default: 500)
  ARTIFACT_HUB_REQUEST_TIMEOUT_MS       Download timeout (default: 120000)
  ARTIFACT_HUB_MAX_RETRIES              Download retries (default: 3)
  LOG_LEVEL                             Log level (default: info)

Notes:
  The mirror is global (no org). A nightly Kubernetes CronJob (gitops repo)
  runs --once, which refreshes the mirror and then runs the attribution pass
  that maps installed charts onto it — see src/artifacthub-sync/README.md.
`,
    loadState: () => repository.getState(),
    formatMetrics: (state) => {
        const ageHours = (Date.now() - state.lastSyncedAt.getTime()) / 3_600_000;
        return `
Artifact Hub Sync State:
  Last synced:          ${state.lastSyncedAt.toISOString()} (${ageHours.toFixed(1)}h ago)${
      isFeedStale(state.lastSyncedAt) ? "  ** STALE **" : ""
  }
  Packages in dump:     ${state.packagesInDump?.toLocaleString() ?? "—"}
  Packages applied:     ${state.packagesApplied?.toLocaleString() ?? "—"}
  Charts examined:      ${state.chartsExamined?.toLocaleString() ?? "—"}
  Attributions written: ${state.attributionsWritten?.toLocaleString() ?? "—"}
  Attributions refused: ${state.attributionsRefused?.toLocaleString() ?? "—"}
  Repos auto-added:     ${state.reposAutoAdded?.toLocaleString() ?? "—"}
  Last error:           ${state.lastError ?? "none"}
`;
    },
    run: (force) =>
        createArtifactHubSyncWorker(config, createArtifactHubDownloader(config), repository).runOnce(
            { force }
        ),
    formatSkipped: (result) =>
        result.reason === "locked"
            ? "Another Artifact Hub sync is running — nothing to do."
            : "Artifact Hub mirror is already fresh — nothing to do.",
    formatResult: (result) =>
        `Artifact Hub sync complete: ${result.packagesApplied?.toLocaleString()} packages applied, ` +
        `${result.packagesPruned?.toLocaleString()} pruned, ` +
        `${result.malformed?.toLocaleString()} malformed.`,
});
