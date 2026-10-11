import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const MINIMAL_SBOM = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
};

let digestCounter = 2000;
function nextDigest(): string {
    digestCounter += 1;
    return `sha256:${String(digestCounter).padStart(64, "0")}`;
}

/**
 * Where each fact ends up.
 *
 * The split is the point of the cutover: facts about the *bytes* go on
 * `images`, facts about the *deployment* go on `workload_containers`, and the
 * SBOM itself carries neither. An SBOM that names a customer's namespace or
 * release cannot be shared across tenants, which is what
 * `base-image-recommendations.md` phase 2 depends on.
 */
describe("POST /v1/sboms/upload/cyclonedx — where image metadata lands", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
    });

    it("puts registry and repository on the image, tag and ref on the container", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx` +
                    `?imageDigest=${digest}` +
                    `&registry=docker.io` +
                    `&repository=library%2Fnginx` +
                    `&imageRef=docker.io%2Flibrary%2Fnginx%3A1.25` +
                    `&tag=1.25` +
                    `&namespace=production&workloadName=nginx&containerName=web`,
            )
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [image] = await db.select().from(schema.images).where(eq(schema.images.digest, digest));
        expect(image).toMatchObject({ registry: "docker.io", repository: "library/nginx" });

        const [container] = await db.select().from(schema.workloadContainers);
        expect(container).toMatchObject({
            imageTag: "1.25",
            imageRef: "docker.io/library/nginx:1.25",
        });
    });

    /**
     * The acceptance criterion, asserted directly: no SBOM row may carry a
     * release name, a namespace or a cluster identity.
     */
    it("stores no deployment context on the sboms row", async () => {
        const db = getTestDb();

        await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx?imageDigest=${nextDigest()}` +
                    `&tag=1.25&namespace=production&workloadName=nginx&containerName=web`,
            )
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [sbom] = await db.select().from(schema.sboms);
        const columns = Object.keys(sbom!);

        for (const forbidden of ["imageTag", "imageRef", "registry", "labels", "namespace", "clusterId", "isCurrent"]) {
            expect(columns).not.toContain(forbidden);
        }
        // What it does carry: the image it describes, and nothing about where
        // that image happens to run.
        expect(sbom!.imageId).toBeDefined();
    });

    it("derives registry and repository from imageRef when they are not sent", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
                    `&imageRef=${encodeURIComponent("localhost:5000/team/myapp:dev")}`,
            )
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [image] = await db.select().from(schema.images).where(eq(schema.images.digest, digest));
        expect(image).toMatchObject({ registry: "localhost:5000", repository: "team/myapp" });
    });

    it("stores tool metadata from the document itself", async () => {
        const db = getTestDb();

        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${nextDigest()}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send({
                ...MINIMAL_SBOM,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    tools: { components: [{ type: "application", name: "syft", version: "1.0.0" }] },
                },
            })
            .expect(201);

        const [sbom] = await db.select().from(schema.sboms);
        expect(sbom!.toolName).toBe("syft");
        expect(sbom!.toolVersion).toBe("1.0.0");
    });
});
