/**
 * Ingestion budget (security review S9): a document within the body-size cap
 * can still describe ~100k components — half a million rows per upload — or
 * nest deeply enough to blow the parser's stack. Both are rejected before
 * any parsing or DB work.
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";

// Imported dynamically in beforeAll: a static import of a src module would
// initialise the app's db connection before the test harness has pointed it
// at the Testcontainers database.
let MAX_SBOM_COMPONENTS: number;
let MAX_SBOM_COMPONENT_DEPTH: number;

function bomWithComponents(components: unknown[]): Record<string, unknown> {
    return {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        components,
    };
}

describe("SBOM ingestion budget", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;
    const digest = `sha256:${"b".repeat(64)}`;

    beforeAll(async () => {
        app = await getTestApp();
        const service = await import("../../../src/services/sbom.service.js");
        MAX_SBOM_COMPONENTS = service.MAX_SBOM_COMPONENTS;
        MAX_SBOM_COMPONENT_DEPTH = service.MAX_SBOM_COMPONENT_DEPTH;
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    it("rejects a document over the component count cap with 413", async () => {
        const components = Array.from({ length: MAX_SBOM_COMPONENTS + 1 }, (_, i) => ({
            type: "library",
            name: `c${i}`,
        }));

        const response = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(bomWithComponents(components));

        expect(response.status).toBe(413);
        expect(response.body.error).toMatch(/components/i);
    });

    it("counts nested components toward the cap", async () => {
        // Half the budget at the top level, each carrying one nested child —
        // together one over the cap.
        const half = Math.ceil((MAX_SBOM_COMPONENTS + 1) / 2);
        const components = Array.from({ length: half }, (_, i) => ({
            type: "library",
            name: `c${i}`,
            components: [{ type: "library", name: `nested${i}` }],
        }));

        const response = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(bomWithComponents(components));

        expect(response.status).toBe(413);
    });

    it("rejects nesting beyond the depth cap with 400", async () => {
        let node: Record<string, unknown> = { type: "library", name: "leaf" };
        for (let i = 0; i < MAX_SBOM_COMPONENT_DEPTH + 1; i++) {
            node = { type: "library", name: `level${i}`, components: [node] };
        }

        const response = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(bomWithComponents([node]));

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/nesting/i);
    });

    it("accepts nesting at the depth cap", async () => {
        let node: Record<string, unknown> = { type: "library", name: "leaf" };
        for (let i = 0; i < MAX_SBOM_COMPONENT_DEPTH - 1; i++) {
            node = { type: "library", name: `level${i}`, components: [node] };
        }

        const response = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(bomWithComponents([node]));

        expect(response.status).toBe(201);
    });
});
