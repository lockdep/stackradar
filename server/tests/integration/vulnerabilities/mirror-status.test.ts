import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import { schema } from "../../../src/db/index.js";

/**
 * Feed health for the app shell's banner: the OSV mirror and the EPSS and KEV
 * feeds that score it. It describes the shared mirror, not any tenant's
 * images, so authentication is the whole gate — but it *is* a gate: this
 * router used to mount with no middleware at all. The status rules are
 * unit-tested in `tests/unit/lib/mirror-status.test.ts`; this is the wiring.
 */
describe("GET /api/vulnerabilities/mirror", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    function authHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    describe("GET /api/vulnerabilities/mirror", () => {
        it("reports every feed pending, and not ready, before any sync has run", async () => {
            const response = await request(app).get("/api/vulnerabilities/mirror").set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                ready: false,
                osv: {
                    status: "pending",
                    initialized: false,
                    initCompletedAt: null,
                    lastError: null,
                    ecosystems: null,
                    bootstrap: null,
                    recordsMirrored: null,
                    bootstrapDurationMs: null,
                },
                epss: {
                    status: "pending",
                    lastSyncedAt: null,
                    runStartedAt: null,
                    lastError: null,
                    scoreDate: null,
                    cvesMatched: null,
                },
                kev: {
                    status: "pending",
                    lastSyncedAt: null,
                    runStartedAt: null,
                    lastError: null,
                    catalogVersion: null,
                    entriesMatched: null,
                },
            });
        });

        it("reports a running bootstrap with its progress, and the feeds it is holding up", async () => {
            const progress = {
                startedAt: "2026-10-17T09:50:00.000Z",
                updatedAt: "2026-10-17T09:59:00.000Z",
                archiveIndex: 2,
                archiveCount: 4,
                ecosystem: "Debian",
                phase: "importing" as const,
                bytesReceived: 50_000_000,
                contentLength: 50_000_000,
                recordsProcessed: 5000,
                archiveEntries: 12_000,
                recordsFromEarlierArchives: 3000,
                archives: [
                    { ecosystem: "Alpine", records: 3000 },
                    { ecosystem: "Debian", records: null },
                    { ecosystem: "Go", records: null },
                    { ecosystem: "npm", records: null },
                ],
            };
            await getTestDb()
                .insert(schema.osvSyncState)
                .values({ id: 1, syncStatus: "full_refresh", bootstrapProgress: progress });

            const response = await request(app).get("/api/vulnerabilities/mirror").set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.ready).toBe(false);
            expect(response.body.osv).toMatchObject({ status: "running", bootstrap: progress });
            expect(response.body.epss.status).toBe("pending");
            expect(response.body.kev.status).toBe("pending");
        });

        it("is ready once the mirror has a generation and both feeds have scored it", async () => {
            const completedAt = new Date("2026-10-10T08:00:00Z");
            const db = getTestDb();
            await db.insert(schema.osvSyncState).values({
                id: 1,
                initialized: true,
                initCompletedAt: completedAt,
                syncStatus: "incremental",
                ecosystems: ["Alpine", "Debian"],
            });
            await db.insert(schema.osvSyncRuns).values([
                {
                    id: "run-rejected",
                    mode: "initialization",
                    success: false,
                    recordsProcessed: 10,
                    durationMs: 5_000,
                    startedAt: new Date("2026-10-10T07:00:00Z"),
                    completedAt: new Date("2026-10-10T07:00:05Z"),
                },
                {
                    id: "run-live",
                    mode: "initialization",
                    success: true,
                    recordsProcessed: 312_480,
                    durationMs: 860_000,
                    startedAt: new Date("2026-10-10T07:45:40Z"),
                    completedAt,
                },
            ]);
            await db.insert(schema.epssSyncState).values({
                id: 1,
                lastSyncedAt: completedAt,
                lastScoreDate: "2026-10-09",
                rowsMatched: 41_000,
            });
            await db.insert(schema.kevSyncState).values({
                id: 1,
                lastSyncedAt: completedAt,
                catalogVersion: "2026.10.09",
                entriesMatched: 1300,
                // A later KEV run is in progress; once a feed has landed, that is no longer the banner's business.
                runStartedAt: new Date(),
            });

            const response = await request(app).get("/api/vulnerabilities/mirror").set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.ready).toBe(true);
            expect(response.body.osv).toMatchObject({
                status: "ready",
                initialized: true,
                initCompletedAt: completedAt.toISOString(),
                ecosystems: ["Alpine", "Debian"],
                recordsMirrored: 312_480,
                bootstrapDurationMs: 860_000,
            });
            expect(response.body.epss).toMatchObject({ status: "ready", scoreDate: "2026-10-09", cvesMatched: 41_000 });
            expect(response.body.kev).toMatchObject({
                status: "ready",
                catalogVersion: "2026.10.09",
                entriesMatched: 1300,
            });
        });

        it("refuses an unauthenticated caller", async () => {
            const response = await request(app).get("/api/vulnerabilities/mirror");
            expect(response.status).toBe(401);
        });
    });
});
