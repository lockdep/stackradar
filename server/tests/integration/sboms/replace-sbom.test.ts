import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    createCluster,
    createClusterApiKey,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const TEST_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function sbomWith(componentName: string) {
    return {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        components: [
            {
                type: "library",
                name: componentName,
                version: "1.0.0",
                purl: `pkg:npm/${componentName}@1.0.0`,
            },
        ],
    };
}

/**
 * The supersede path, enabled by ADR 0006: an SBOM's blast radius is one
 * cluster now, so first-writer-wins no longer needs to be permanent.
 * `?replace=true` is the recovery path for a bad scanner version or a
 * truncated upload.
 */
describe("POST /v1/sboms/upload/cyclonedx?replace=true", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    function upload(body: unknown, query = "", key = testData.apiKey.rawKey) {
        return request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${TEST_DIGEST}${query}`)
            .set(createApiKeyHeaders(key))
            .send(body as object);
    }

    it("replaces the existing SBOM and its component subtree atomically", async () => {
        const db = getTestDb();
        await upload(sbomWith("lodash")).expect(201);

        const response = await upload(sbomWith("express"), "&replace=true");
        expect(response.status).toBe(201);

        // Still one SBOM per image — the old subtree is gone, not superseded
        // in place.
        const sboms = await db.select().from(schema.sboms);
        expect(sboms).toHaveLength(1);

        const components = await db.select().from(schema.components);
        expect(components).toHaveLength(1);
        expect(components[0]!.name).toBe("express");
    });

    it("still answers 409 for a duplicate without replace", async () => {
        await upload(sbomWith("lodash")).expect(201);
        const response = await upload(sbomWith("express"));
        expect(response.status).toBe(409);
    });

    it("creates normally when there is nothing to replace", async () => {
        const db = getTestDb();
        await upload(sbomWith("lodash"), "&replace=true").expect(201);
        expect(await db.select().from(schema.sboms)).toHaveLength(1);
    });

    it("cannot replace a sibling cluster's SBOM — it never sees it", async () => {
        const db = getTestDb();
        await upload(sbomWith("lodash")).expect(201);

        const siblingCluster = await createCluster(db, testData.org.id, { name: "staging" });
        const siblingKey = await createClusterApiKey(db, siblingCluster.id, testData.org.id, testData.user.id);

        // The sibling's "replace" lands on its own (cluster, digest) image —
        // a create, not a replacement of the first cluster's document.
        await upload(sbomWith("express"), "&replace=true", siblingKey.rawKey).expect(201);

        const sboms = await db.select().from(schema.sboms);
        expect(sboms).toHaveLength(2);
        const componentNames = (await db.select().from(schema.components)).map((c) => c.name).sort();
        expect(componentNames).toEqual(["express", "lodash"]);
    });

    it("queues a fresh vulnerability scan for the replacement", async () => {
        const db = getTestDb();
        await upload(sbomWith("lodash")).expect(201);
        await upload(sbomWith("express"), "&replace=true").expect(201);

        const [image] = await db.select().from(schema.images).where(eq(schema.images.digest, TEST_DIGEST));
        const scans = await db.select().from(schema.jobs).where(eq(schema.jobs.imageId, image!.id));
        // One from the original upload (whose sbom is now gone, so its job row
        // was deleted with the subtree) plus one live job for the replacement.
        expect(scans.length).toBeGreaterThanOrEqual(1);
        const live = await db
            .select()
            .from(schema.jobs)
            .where(eq(schema.jobs.sbomId, (await db.select().from(schema.sboms))[0]!.id));
        expect(live.length).toBe(1);
    });

    it("records the scanner version that produced the document", async () => {
        const db = getTestDb();
        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${TEST_DIGEST}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .set("X-Scanner-Version", "1.4.2")
            .send(sbomWith("lodash"))
            .expect(201);

        const [sbom] = await db.select().from(schema.sboms);
        expect(sbom!.scannerVersion).toBe("1.4.2");
    });
});
