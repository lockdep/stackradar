import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, withFindingIdentity, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

describe("GET /api/vulnerabilities/:vulnId", () => {
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

    it("returns 404 when vulnerability is not found", async () => {
        const response = await request(app).get("/api/vulnerabilities/CVE-DOES-NOT-EXIST").set(authHeaders());

        expect(response.status).toBe(404);
        expect(response.body.error).toMatch(/not found/i);
    });

    it("returns 200 with vulnerability data when seeded", async () => {
        const db = getTestDb();
        await db.insert(schema.vulnerabilities).values(
            withFindingIdentity([
                {
                    vulnId: "CVE-2024-12345",
                    source: "osv",
                    summary: "Test vulnerability",
                    severityLevel: "HIGH",
                    cvssScore: 7.5,
                },
            ]),
        );

        const response = await request(app).get("/api/vulnerabilities/CVE-2024-12345").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            vulnId: "CVE-2024-12345",
            source: "osv",
            summary: "Test vulnerability",
            severityLevel: "HIGH",
            cvssScore: 7.5,
        });
    });

    /**
     * The advisory itself is deliberately not org-scoped — it is a public fact
     * about the world, the same record for every tenant. Only the *link* from
     * an advisory to a customer's component is tenant data, and that is reached
     * through `/component/:componentId`, which does check.
     */
    it("serves the same advisory to any authenticated org", async () => {
        const db = getTestDb();
        await db.insert(schema.vulnerabilities).values(
            withFindingIdentity([
                {
                    vulnId: "CVE-2024-12345",
                    source: "osv",
                    summary: "Test vulnerability",
                    severityLevel: "HIGH",
                    cvssScore: 7.5,
                },
            ]),
        );

        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-vuln" });
        const response = await request(app)
            .get("/api/vulnerabilities/CVE-2024-12345")
            .set(
                createInternalHeaders({
                    id: other.user.id,
                    email: other.user.email,
                    orgId: other.org.id,
                    orgName: other.org.name,
                    orgSlug: other.org.slug,
                }),
            );

        expect(response.status).toBe(200);
    });

    it("refuses an unauthenticated caller", async () => {
        const response = await request(app).get("/api/vulnerabilities/CVE-2024-12345");
        expect(response.status).toBe(401);
    });
});
