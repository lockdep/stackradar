import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";

/** Distinct per test so nothing collides on `sboms_image_id_unique`. */
let digestCounter = 0;
function nextDigest(): string {
    digestCounter += 1;
    return `sha256:${String(digestCounter).padStart(64, "0")}`;
}

describe("POST /v1/sboms/upload/cyclonedx", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;
    let uploadUrl: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
        uploadUrl = `/v1/sboms/upload/cyclonedx?imageDigest=${nextDigest()}`;
    });

    describe("schema validation", () => {
        it("should accept a valid CycloneDX SBOM", async () => {
            const validSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: {
                        type: "application",
                        name: "test-app",
                        version: "1.0.0",
                    },
                },
                components: [
                    {
                        type: "library",
                        name: "lodash",
                        version: "4.17.21",
                        purl: "pkg:npm/lodash@4.17.21",
                    },
                ],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(validSbom);

            expect(response.status).toBe(201);
            expect(response.body.id).toBeDefined();
        });

        it("should reject SBOM without bomFormat", async () => {
            const invalidSbom = {
                specVersion: "1.6",
                components: [],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
            expect(response.body.error).toMatch(/bomFormat/i);
        });

        it("should reject SBOM without specVersion", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                components: [],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
            expect(response.body.error).toMatch(/specVersion/i);
        });

        it("should reject SBOM with invalid bomFormat value", async () => {
            const invalidSbom = {
                bomFormat: "SPDX",
                specVersion: "1.6",
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });

        it("should reject a real SPDX document with a message naming the format", async () => {
            // A genuine SPDX doc has no `bomFormat` at all, so without the explicit
            // check it fails the CycloneDX schema on missing required fields and the
            // error never says "you uploaded SPDX".
            const spdxSbom = {
                spdxVersion: "SPDX-2.3",
                SPDXID: "SPDXRef-DOCUMENT",
                name: "test-document",
                packages: [{ SPDXID: "SPDXRef-Package-1", name: "lodash", versionInfo: "4.17.21" }],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(spdxSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/SPDX/);
            expect(response.body.error).toMatch(/CycloneDX only/i);
        });

        it("should reject SBOM with invalid version type", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: "1", // Should be integer, not string
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });

        it("should reject SBOM with invalid serialNumber format", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                serialNumber: "invalid-serial",
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });

        it("should reject SBOM with invalid component type", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                components: [
                    {
                        type: "not-a-valid-type",
                        name: "test",
                    },
                ],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });

        it("should reject SBOM with additional unknown properties", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                unknownField: "should not be here",
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });

        it("should reject SBOM with specVersion 1.5 (only 1.6 supported)", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.5",
                version: 1,
                components: [],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });

        it("should reject SBOM with specVersion 1.4 (only 1.6 supported)", async () => {
            const invalidSbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.4",
                version: 1,
                components: [],
            };

            const response = await request(app)
                .post(uploadUrl)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(invalidSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/Invalid CycloneDX format/i);
        });
    });

    describe("image identity", () => {
        const validSbom = { bomFormat: "CycloneDX", specVersion: "1.6" };

        it("should return 400 when imageDigest is missing", async () => {
            const response = await request(app)
                .post("/v1/sboms/upload/cyclonedx")
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(validSbom);

            expect(response.status).toBe(400);
        });

        /* Half a workload identity would silently create rows under a
           placeholder name, and placeholders outlive the request that made
           them. All three or none. */
        it("should return 400 for a partially specified workload identity", async () => {
            const response = await request(app)
                .post(`/v1/sboms/upload/cyclonedx?imageDigest=${nextDigest()}&namespace=prod`)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(validSbom);

            expect(response.status).toBe(400);
            expect(response.body.error).toMatch(/namespace, workloadName and containerName/i);
        });
    });
});
