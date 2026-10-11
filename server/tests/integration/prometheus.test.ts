import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp } from "../setup/test-app.js";
import { getTestDb } from "../setup/test-db.js";
import * as schema from "../../src/db/schema/index.js";

/**
 * Pull a single unlabelled sample out of the exposition text. Returns null when
 * the series is absent, which several of these assertions care about: a reset
 * gauge must go missing rather than report a misleading 0.
 */
function sample(body: string, name: string): number | null {
    const match = body.match(new RegExp(`^${name} (\\S+)$`, "m"));
    return match ? Number(match[1]) : null;
}

describe("GET /metrics", () => {
    let app: Express;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await getTestDb().delete(schema.osvSyncState);
    });

    it("serves the Prometheus exposition format", async () => {
        const response = await request(app).get("/metrics");

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/plain");
        expect(response.headers["content-type"]).toContain("version=0.0.4");
    });

    it("includes the process and Node.js runtime defaults", async () => {
        const response = await request(app).get("/metrics");

        expect(response.text).toContain("process_cpu_seconds_total");
        expect(response.text).toContain("nodejs_eventloop_lag_seconds");
    });

    it("reports mirror health from the sync state row", async () => {
        const now = Date.now();
        await getTestDb()
            .insert(schema.osvSyncState)
            .values({
                id: 1,
                initialized: true,
                lastSuccessfulPollAt: new Date(now - 300_000),
                lastModifiedSeen: new Date(now - 60_000),
                lastModifiedApplied: new Date(now - 120_000),
                consecutiveFailures: 2,
            });

        const response = await request(app).get("/metrics");
        const body = response.text;

        expect(sample(body, "osv_mirror_initialized")).toBe(1);
        expect(sample(body, "osv_mirror_consecutive_failures")).toBe(2);
        expect(sample(body, "osv_mirror_scrape_error")).toBe(0);
        // seen (now-60s) minus applied (now-120s)
        expect(sample(body, "osv_mirror_lag_seconds")).toBe(60);
        expect(sample(body, "osv_mirror_last_successful_poll_age_seconds")).toBeGreaterThanOrEqual(300);
    });

    it("reports an uninitialized mirror without inventing timestamps", async () => {
        await getTestDb().insert(schema.osvSyncState).values({ id: 1, initialized: false });

        const response = await request(app).get("/metrics");
        const body = response.text;

        expect(sample(body, "osv_mirror_initialized")).toBe(0);
        expect(sample(body, "osv_mirror_scrape_error")).toBe(0);
        // A mirror that has never polled or applied anything has no age and no
        // lag. Emitting 0 for either would read as "perfectly fresh" — the
        // exact opposite of the truth — so both series must be absent.
        expect(sample(body, "osv_mirror_last_successful_poll_age_seconds")).toBeNull();
        expect(sample(body, "osv_mirror_lag_seconds")).toBeNull();
    });

    it("reports initialized=0 when the sync has never run at all", async () => {
        const response = await request(app).get("/metrics");
        const body = response.text;

        expect(sample(body, "osv_mirror_initialized")).toBe(0);
        expect(sample(body, "osv_mirror_scrape_error")).toBe(0);
        expect(sample(body, "osv_mirror_last_successful_poll_age_seconds")).toBeNull();
    });

    it("does not leak state between scrapes", async () => {
        await getTestDb()
            .insert(schema.osvSyncState)
            .values({
                id: 1,
                initialized: true,
                lastModifiedSeen: new Date(),
                lastModifiedApplied: new Date(Date.now() - 45_000),
                consecutiveFailures: 7,
            });
        await request(app).get("/metrics");

        // The gauges are module-level singletons, so a subsequent scrape that
        // finds different state has to overwrite them, not add to them.
        await getTestDb().delete(schema.osvSyncState);
        const response = await request(app).get("/metrics");

        expect(sample(response.text, "osv_mirror_consecutive_failures")).toBe(0);
        expect(sample(response.text, "osv_mirror_lag_seconds")).toBeNull();
    });
});
