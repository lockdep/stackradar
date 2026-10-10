import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createCluster,
    createClusterApiKey,
    createExpiredApiKey,
    createOrgWithOwner,
    createRevokedApiKey,
    seedTestScenario,
    type CreateOrgWithOwnerResult,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

const TEST_DIGEST = "sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

/**
 * API keys are scanner credentials: they authenticate the `/v1` ingest
 * surface and nothing else. `requireInternal` turns them away from every
 * management route with a 403 — the distinction from 401 matters, because the
 * key IS valid; it is the surface that refuses it.
 */
describe("API key authentication", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    it("authenticates the scanner surface with a valid cluster-scoped key", async () => {
        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey));

        expect(response.status).toBe(200);
        expect(response.body.exists).toBe(false);
    });

    it("rejects a valid key on management routes with 403", async () => {
        for (const path of [
            `/api/organizations/${testData.org.id}`,
            "/api/clusters",
            `/api/clusters/${testData.cluster.id}/api-key`,
            "/api/jobs",
        ]) {
            const response = await request(app)
                .get(path)
                .set(createApiKeyHeaders(testData.apiKey.rawKey));
            expect(response.status, path).toBe(403);
        }
    });

    it("rejects a key without the sbom:write scope with 403", async () => {
        const db = getTestDb();
        const { rawKey } = await createClusterApiKey(
            db,
            testData.cluster.id,
            testData.org.id,
            testData.user.id,
            { name: "Scopeless Key", scopes: [] },
        );

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(rawKey));

        expect(response.status).toBe(403);
    });

    it("rejects an expired API key", async () => {
        const db = getTestDb();
        const { rawKey } = await createExpiredApiKey(db, testData.org.id, testData.user.id);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(rawKey));

        expect(response.status).toBe(401);
    });

    it("rejects a revoked API key", async () => {
        const db = getTestDb();
        const { rawKey } = await createRevokedApiKey(db, testData.org.id, testData.user.id);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(rawKey));

        expect(response.status).toBe(401);
    });

    it("rejects a malformed API key", async () => {
        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders("invalid-key-format"));

        expect(response.status).toBe(401);
    });

    it("rejects a request without any authentication", async () => {
        const response = await request(app).get(
            `/v1/sboms/check?imageDigest=${TEST_DIGEST}`,
        );

        expect(response.status).toBe(401);
    });

    it("keeps one org's key out of another org entirely", async () => {
        const db = getTestDb();
        const other: CreateOrgWithOwnerResult = await createOrgWithOwner(db, {
            email: "other-owner@example.com",
        });
        const otherCluster = await createCluster(db, other.org.id);
        const { rawKey } = await createClusterApiKey(
            db,
            otherCluster.id,
            other.org.id,
            other.user.id,
        );

        // Even on the surface keys are for, the answer is scoped to the key's
        // own cluster — and management routes 403 regardless of org.
        const response = await request(app)
            .get(`/api/organizations/${testData.org.id}`)
            .set(createApiKeyHeaders(rawKey));

        expect(response.status).toBe(403);
    });
});
