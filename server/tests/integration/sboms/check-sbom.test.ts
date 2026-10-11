import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    createApiKey,
    createCluster,
    createClusterApiKey,
    createOrgWithOwner,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

const MINIMAL_SBOM = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
};

const TEST_DIGEST = "sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

/**
 * The dedup check, keyed on `(cluster, digest)`.
 *
 * The scanner asks it before every pull. Within a cluster it still collapses
 * N namespaces running one digest into one pull, one syft run and one
 * matching pass — but the answer is scoped to the asking cluster (ADR 0006):
 * the global answer was an oracle over every tenant's scanning activity, and
 * it was what let one tenant's upload stop every other tenant from ever
 * scanning a digest.
 */
describe("GET /v1/sboms/check", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    async function upload(digest: string, query = ""): Promise<void> {
        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}${query}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);
    }

    it("returns exists:true once any SBOM for that digest exists", async () => {
        await upload(TEST_DIGEST);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ exists: true });
    });

    it("returns exists:false for a digest nothing has scanned", async () => {
        const other = "sha256:000000000000000000000000000000000000000000000000000000000000ffff";
        await upload(TEST_DIGEST);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${other}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ exists: false });
    });

    /**
     * The behaviour change, stated as a test: the same digest reported from a
     * different namespace, a different workload or a different container is
     * still the same bytes and must not be pulled again.
     */
    it("ignores namespace, workload and container entirely", async () => {
        await upload(TEST_DIGEST, "&namespace=production&workloadName=api&containerName=main");

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey));

        expect(response.body).toEqual({ exists: true });
    });

    /**
     * The core isolation property (ADR 0006): the answer depends on which
     * cluster is asking. "Someone scanned this digest" leaking across tenants
     * was an oracle; leaking across clusters of one org would still let a
     * poisoned upload in staging suppress prod's scan.
     */
    it("answers false for another cluster of the same org", async () => {
        const db = getTestDb();
        await upload(TEST_DIGEST);

        const siblingCluster = await createCluster(db, testData.org.id, { name: "staging" });
        const siblingKey = await createClusterApiKey(db, siblingCluster.id, testData.org.id, testData.user.id);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(siblingKey.rawKey));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ exists: false });
    });

    it("answers false across organizations", async () => {
        const db = getTestDb();
        await upload(TEST_DIGEST);

        const { org: otherOrg, user: otherUser } = await createOrgWithOwner(
            db,
            {},
            { name: "Other Org", slug: "other-check" },
        );
        const otherCluster = await createCluster(db, otherOrg.id);
        const otherKey = await createClusterApiKey(db, otherCluster.id, otherOrg.id, otherUser.id);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(otherKey.rawKey));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ exists: false });
    });

    it("rejects an org-scoped key with 403", async () => {
        const db = getTestDb();
        const orgKey = await createApiKey(db, testData.org.id, testData.user.id);

        const response = await request(app)
            .get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(orgKey.rawKey));

        expect(response.status).toBe(403);
        expect(response.body.error).toMatch(/cluster-scoped/i);
    });

    it("returns 400 when imageDigest is missing", async () => {
        const response = await request(app).get("/v1/sboms/check").set(createApiKeyHeaders(testData.apiKey.rawKey));

        expect(response.status).toBe(400);
    });

    it("rejects unauthenticated requests", async () => {
        const response = await request(app).get(`/v1/sboms/check?imageDigest=${TEST_DIGEST}`);
        expect(response.status).toBe(401);
    });
});
