import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import { schema } from "../../../src/db/index.js";

/**
 * Mirror health and fleet-wide advisory counts. These describe the OSV mirror,
 * not any tenant's images, so authentication is the whole gate — but it *is* a
 * gate now: this router used to mount with no middleware at all.
 */
describe("vulnerability mirror status endpoints", () => {
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

    describe("GET /api/vulnerabilities/stats", () => {
        it("returns total, bySource, and bySeverity shape", async () => {
            const response = await request(app)
                .get("/api/vulnerabilities/stats")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                total: expect.any(Number),
                bySource: expect.any(Array),
                bySeverity: expect.any(Array),
            });
        });

        it("refuses an unauthenticated caller", async () => {
            const response = await request(app).get("/api/vulnerabilities/stats");
            expect(response.status).toBe(401);
        });
    });

    describe("GET /api/vulnerabilities/mirror", () => {
        it("reports an uninitialised mirror before any sync has run", async () => {
            const response = await request(app)
                .get("/api/vulnerabilities/mirror")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                initialized: false,
                syncStatus: "idle",
                initCompletedAt: null,
                lastSuccessfulPollAt: null,
                lastError: null,
                ecosystems: null,
            });
        });

        it("reflects the state row once a bootstrap has published a generation", async () => {
            const completedAt = new Date("2026-10-10T08:00:00Z");
            await getTestDb().insert(schema.osvSyncState).values({
                id: 1,
                initialized: true,
                initCompletedAt: completedAt,
                syncStatus: "incremental",
                ecosystems: ["Alpine", "Debian"],
            });

            const response = await request(app)
                .get("/api/vulnerabilities/mirror")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                initialized: true,
                syncStatus: "incremental",
                initCompletedAt: completedAt.toISOString(),
                ecosystems: ["Alpine", "Debian"],
            });
        });

        it("refuses an unauthenticated caller", async () => {
            const response = await request(app).get("/api/vulnerabilities/mirror");
            expect(response.status).toBe(401);
        });
    });

    describe("GET /api/vulnerabilities/sync/status", () => {
        it("returns statuses and stats shape", async () => {
            const response = await request(app)
                .get("/api/vulnerabilities/sync/status")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                statuses: expect.any(Array),
                stats: expect.objectContaining({
                    total: expect.any(Number),
                }),
            });
        });

        it("refuses an unauthenticated caller", async () => {
            const response = await request(app).get("/api/vulnerabilities/sync/status");
            expect(response.status).toBe(401);
        });
    });
});
