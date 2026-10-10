import { Registry, Gauge, collectDefaultMetrics } from "prom-client";
import { osvMetricsRepository } from "../repositories/osv-metrics.repository.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("prometheus-service");

/**
 * A private registry rather than prom-client's global default. The default
 * registry is process-wide shared state, which makes double-registration
 * errors possible the moment anything else in the process reaches for it
 * (a test importing `src/app.ts` twice, a future library that self-registers).
 * Nothing outside this module can collide with this one.
 */
const registry = new Registry();

// process_* and nodejs_* for the API server itself: heap, event loop lag, GC,
// open handles. Free relative to the scrape it rides along with, and it is the
// data you want the moment someone asks why the server is slow.
collectDefaultMetrics({ register: registry });

const initialized = new Gauge({
    name: "osv_mirror_initialized",
    help: "1 when a complete generation of the OSV mirror exists, 0 otherwise. While this is 0 the read guard 503s vulnerability matching.",
    registers: [registry],
});

/**
 * Age of the last *successful* poll — the only metric here that notices a sync
 * which has stopped running altogether.
 *
 * `osv_mirror_lag_seconds` cannot: it is derived from two columns that a
 * non-running sync never updates, so a CronJob that is failing to schedule, or
 * whose pods die before they reach Postgres, leaves lag frozen at whatever it
 * last was — usually 0. A silent stop is the failure mode this design cannot
 * self-detect, so alert on this one.
 */
const lastSuccessfulPollAge = new Gauge({
    name: "osv_mirror_last_successful_poll_age_seconds",
    help: "Seconds since the OSV sync last completed a successful poll. Grows without bound if the sync stops running.",
    registers: [registry],
});

const lagSeconds = new Gauge({
    name: "osv_mirror_lag_seconds",
    help: "Backlog between the newest record OSV has published (last_modified_seen) and the newest one applied locally (last_modified_applied).",
    registers: [registry],
});

const consecutiveFailures = new Gauge({
    name: "osv_mirror_consecutive_failures",
    help: "Consecutive failed OSV sync cycles. Reset to 0 by any successful cycle.",
    registers: [registry],
});

/**
 * Exposed so a broken exporter is visible as a value rather than as absent
 * series. Without it, a failing state query and a Prometheus that has lost the
 * target look identical from an alert rule's point of view, and `absent()`
 * rules are easy to get wrong.
 */
const scrapeError = new Gauge({
    name: "osv_mirror_scrape_error",
    help: "1 when the most recent scrape could not read the OSV sync state from the database, 0 otherwise.",
    registers: [registry],
});

/** Seconds between `date` and now, floored at 0 to keep clock skew out of the series. */
function ageSeconds(date: Date, now: number): number {
    return Math.max(0, (now - date.getTime()) / 1000);
}

/**
 * Drop a gauge's series so it is *absent* from the next scrape.
 *
 * `Gauge.reset()` is the wrong tool here: on a gauge with no labels it
 * re-seeds the series at 0 rather than removing it, which for a freshness
 * metric is the most dangerous value it could report — "zero seconds of lag"
 * and "we have no idea" would look identical on a dashboard. `remove()` with
 * no label values deletes the entry outright.
 */
function clear(gauge: Gauge): void {
    gauge.remove();
}

export const prometheusService = {
    contentType: registry.contentType,

    /**
     * Refresh the OSV gauges from the database and render the whole registry.
     *
     * A database failure is caught rather than thrown: an exporter that returns
     * 500 takes down `process_*` and `nodejs_*` too, and those are exactly what
     * you want during a database incident. The mirror gauges are cleared so
     * they go absent instead of flatlining at a stale value, and
     * `osv_mirror_scrape_error` carries the truth.
     */
    async collect(): Promise<string> {
        try {
            const health = await osvMetricsRepository.getMirrorHealth();
            const now = Date.now();

            if (!health) {
                // No state row at all — the sync has never been invoked. Report
                // the one thing that is unambiguously true and leave the
                // time-derived gauges absent; there is no timestamp to age.
                initialized.set(0);
                clear(lastSuccessfulPollAge);
                clear(lagSeconds);
                consecutiveFailures.set(0);
                scrapeError.set(0);
                return registry.metrics();
            }

            initialized.set(health.initialized ? 1 : 0);
            consecutiveFailures.set(health.consecutiveFailures);

            if (health.lastSuccessfulPollAt) {
                lastSuccessfulPollAge.set(ageSeconds(health.lastSuccessfulPollAt, now));
            } else {
                clear(lastSuccessfulPollAge);
            }

            // Mirrors `SyncStateManager.getLagSeconds()`: null unless both
            // watermarks exist, so a fresh mirror does not report a lag of 0
            // and look healthy before it has ever applied anything.
            if (health.lastModifiedSeen && health.lastModifiedApplied) {
                const seen = health.lastModifiedSeen.getTime();
                const applied = health.lastModifiedApplied.getTime();
                lagSeconds.set(Math.max(0, Math.floor((seen - applied) / 1000)));
            } else {
                clear(lagSeconds);
            }

            scrapeError.set(0);
        } catch (error) {
            log.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to read OSV sync state for metrics scrape"
            );
            clear(initialized);
            clear(lastSuccessfulPollAge);
            clear(lagSeconds);
            clear(consecutiveFailures);
            scrapeError.set(1);
        }

        return registry.metrics();
    },
};
