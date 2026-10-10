/**
 * `requireOrg` re-verifies membership server-side (security review S3).
 *
 * The BFF's `X-Org-Id` header is a claim: any caller holding the internal
 * key could previously scope itself into any org. These tests pin the new
 * behaviour — a non-member's org claim is a 403, a member's passes, and a
 * deleted org stops resolving for everyone, members included.
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    createUser,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("requireOrg membership verification", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    it("allows a member through org-scoped routes", async () => {
        const response = await request(app)
            .get("/api/clusters")
            .set(
                createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                })
            );
        expect(response.status).toBe(200);
    });

    it("rejects a non-member claiming the org in X-Org-Id", async () => {
        const outsider = await createUser(getTestDb(), { email: "outsider@example.com" });

        const response = await request(app)
            .get("/api/clusters")
            .set(
                createInternalHeaders({
                    id: outsider.id,
                    email: outsider.email,
                    orgId: testData.org.id,
                })
            );
        expect(response.status).toBe(403);
    });

    it("rejects members of a soft-deleted org", async () => {
        const { organizationRepository } = await import(
            "../../../src/repositories/organization.repository.js"
        );
        await organizationRepository.deleteOrganization(testData.org.id);

        const response = await request(app)
            .get("/api/clusters")
            .set(
                createInternalHeaders({
                    id: testData.user.id,
                    email: testData.user.email,
                    orgId: testData.org.id,
                })
            );
        expect(response.status).toBe(403);
    });

    it("deactivates the org's API keys when the org is deleted (S5)", async () => {
        const smallSbom = {
            bomFormat: "CycloneDX",
            specVersion: "1.6",
            version: 1,
            components: [],
        };
        const url = `/v1/sboms/upload/cyclonedx?imageDigest=sha256:${"c".repeat(64)}`;

        const before = await request(app)
            .post(url)
            .set({ "X-API-Key": testData.apiKey.rawKey })
            .send(smallSbom);
        expect(before.status).toBe(201);

        const { organizationRepository } = await import(
            "../../../src/repositories/organization.repository.js"
        );
        await organizationRepository.deleteOrganization(testData.org.id);

        const after = await request(app)
            .post(url + "&replace=true")
            .set({ "X-API-Key": testData.apiKey.rawKey })
            .send(smallSbom);
        expect(after.status).toBe(401);
    });
});
