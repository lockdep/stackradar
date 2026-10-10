import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

/** Each test uploads under its own digest — one SBOM per image is enforced. */
let digestCounter = 3000;
function nextDigest(): string {
    digestCounter += 1;
    return `sha256:${String(digestCounter).padStart(64, "0")}`;
}

type TestData = SeedTestScenarioResult;

function makeHeaders(testData: TestData) {
    return createApiKeyHeaders(testData.apiKey.rawKey);
}

describe("POST /api/sboms/upload/cyclonedx — stored data verification", () => {
    let app: Express;
    let testData: TestData;
    let uploadUrl: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        const scenarioData = await seedTestScenario(db);
        testData = scenarioData;
        uploadUrl = `/api/sboms/upload/cyclonedx?imageDigest=${nextDigest()}`;
    });

    describe("component storage", () => {
        it("should store multiple components with correct data", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    {
                        type: "library",
                        name: "lodash",
                        version: "4.17.21",
                        purl: "pkg:npm/lodash@4.17.21",
                        "bom-ref": "lodash-ref",
                        group: "utils",
                        publisher: "JS Foundation",
                        description: "A utility library",
                    },
                    {
                        type: "library",
                        name: "express",
                        version: "4.18.2",
                        purl: "pkg:npm/express@4.18.2",
                        "bom-ref": "express-ref",
                    },
                    {
                        type: "library",
                        name: "no-purl-lib",
                        version: "1.0.0",
                    },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);
            expect(res.body.componentCount).toBe(3);

            const db = getTestDb();
            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            expect(components).toHaveLength(3);

            const lodash = components.find(c => c.name === "lodash");
            expect(lodash).toBeDefined();
            expect(lodash!.version).toBe("4.17.21");
            expect(lodash!.purl).toBe("pkg:npm/lodash@4.17.21");
            expect(lodash!.groupName).toBe("utils");
            expect(lodash!.publisher).toBe("JS Foundation");
            expect(lodash!.description).toBe("A utility library");

            const noUrlLib = components.find(c => c.name === "no-purl-lib");
            expect(noUrlLib).toBeDefined();
            expect(noUrlLib!.purl).toBeNull();
        });

        it("should mark components with correct isDirect based on dependency graph", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0", "bom-ref": "app-ref" },
                },
                components: [
                    { type: "library", name: "top-level-dep", version: "1.0.0", purl: "pkg:npm/top-level-dep@1.0.0", "bom-ref": "top-ref" },
                    { type: "library", name: "transitive-dep", version: "2.0.0", purl: "pkg:npm/transitive-dep@2.0.0", "bom-ref": "transitive-ref" },
                ],
                dependencies: [
                    { ref: "top-ref", dependsOn: ["transitive-ref"] },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);

            const db = getTestDb();
            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            const topLevel = components.find(c => c.name === "top-level-dep");
            const transitiveDep = components.find(c => c.name === "transitive-dep");

            expect(topLevel?.isDirect).toBe(true);
            expect(transitiveDep?.isDirect).toBe(false);
        });

        it("should store component dependencies in the dependency graph", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0", "bom-ref": "app-ref" },
                },
                components: [
                    { type: "library", name: "parent", version: "1.0.0", purl: "pkg:npm/parent@1.0.0", "bom-ref": "parent-ref" },
                    { type: "library", name: "child-a", version: "1.0.0", purl: "pkg:npm/child-a@1.0.0", "bom-ref": "child-a-ref" },
                    { type: "library", name: "child-b", version: "2.0.0", purl: "pkg:npm/child-b@2.0.0", "bom-ref": "child-b-ref" },
                ],
                dependencies: [
                    { ref: "parent-ref", dependsOn: ["child-a-ref", "child-b-ref"] },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);

            const db = getTestDb();
            const deps = await db
                .select()
                .from(schema.componentDependencies)
                .where(eq(schema.componentDependencies.sbomId, res.body.id));

            expect(deps).toHaveLength(2);

            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            const parentComp = components.find(c => c.name === "parent");
            const childA = components.find(c => c.name === "child-a");
            const childB = components.find(c => c.name === "child-b");

            const parentIds = deps.map(d => d.parentComponentId);
            const childIds = deps.map(d => d.childComponentId);

            expect(parentIds).toEqual([parentComp!.id, parentComp!.id]);
            expect(childIds).toContain(childA!.id);
            expect(childIds).toContain(childB!.id);
        });
    });

    describe("licenses", () => {
        it("should store SPDX licenses and link them to components", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    {
                        type: "library",
                        name: "licensed-lib",
                        version: "1.0.0",
                        purl: "pkg:npm/licensed-lib@1.0.0",
                        licenses: [
                            { license: { id: "MIT" } },
                        ],
                    },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);

            const db = getTestDb();
            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            const component = components.find(c => c.name === "licensed-lib");

            const links = await db
                .select({ spdxId: schema.licenses.spdxId })
                .from(schema.componentLicenses)
                .innerJoin(schema.licenses, eq(schema.componentLicenses.licenseId, schema.licenses.id))
                .where(eq(schema.componentLicenses.componentId, component!.id));

            expect(links).toHaveLength(1);
            expect(links[0]!.spdxId).toBe("MIT");
        });
    });

    describe("hashes and external references", () => {
        it("should store component hashes", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    {
                        type: "library",
                        name: "hashed-lib",
                        version: "1.0.0",
                        purl: "pkg:npm/hashed-lib@1.0.0",
                        hashes: [
                            { alg: "SHA-256", content: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
                            { alg: "SHA-512", content: "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e" },
                        ],
                    },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);

            const db = getTestDb();
            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            const component = components.find(c => c.name === "hashed-lib");

            const hashes = await db
                .select()
                .from(schema.componentHashes)
                .where(eq(schema.componentHashes.componentId, component!.id));

            expect(hashes).toHaveLength(2);
            expect(hashes.map(h => h.algorithm).sort()).toEqual(["SHA-256", "SHA-512"]);
        });

        it("should store external references", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    {
                        type: "library",
                        name: "ref-lib",
                        version: "1.0.0",
                        purl: "pkg:npm/ref-lib@1.0.0",
                        externalReferences: [
                            { type: "vcs", url: "https://github.com/example/ref-lib" },
                            { type: "website", url: "https://ref-lib.io" },
                        ],
                    },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);

            const db = getTestDb();
            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            const component = components.find(c => c.name === "ref-lib");

            const refs = await db
                .select()
                .from(schema.componentExternalRefs)
                .where(eq(schema.componentExternalRefs.componentId, component!.id));

            expect(refs).toHaveLength(2);
            expect(refs.map(r => r.type).sort()).toEqual(["vcs", "website"]);
        });
    });

    describe("deduplication", () => {
        it("should return 409 for duplicate SBOM upload", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    { type: "library", name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" },
                ],
            };

            const res1 = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);
            expect(res1.status).toBe(201);

            const res2 = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);
            expect(res2.status).toBe(409);
            expect(res2.body.error).toBe("This image already has an SBOM");
        });

        /* Two *images*, two SBOMs. A single image cannot have two, so the
           no-cross-SBOM-dedup property is now asserted across images — which is
           where it matters, since two images legitimately share a component. */
        it("should create separate component rows for each SBOM (no cross-SBOM dedup)", async () => {
            const secondUrl = `/api/sboms/upload/cyclonedx?imageDigest=${nextDigest()}`;
            const sbom1 = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000001",
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    { type: "library", name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" },
                ],
            };

            const sbom2 = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000002",
                metadata: {
                    timestamp: "2024-02-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.1.0" },
                },
                components: [
                    { type: "library", name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21" },
                ],
            };

            const res1 = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom1);
            expect(res1.status).toBe(201);

            const res2 = await request(app)
                .post(secondUrl)
                .set(makeHeaders(testData))
                .send(sbom2);
            expect(res2.status).toBe(201);

            const db = getTestDb();

            // Each SBOM gets its own component rows
            const comp1 = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res1.body.id));
            const comp2 = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res2.body.id));

            expect(comp1).toHaveLength(1);
            expect(comp2).toHaveLength(1);
            expect(comp1[0]!.id).not.toBe(comp2[0]!.id);

            // Two separate SBOMs should exist, one per image.
            const sboms = await db.select().from(schema.sboms);
            expect(sboms).toHaveLength(2);
            expect(new Set(sboms.map((s) => s.imageId)).size).toBe(2);
        });
    });

    describe("SBOM metadata", () => {
        it("should store tool and source metadata", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
                metadata: {
                    timestamp: "2024-06-15T10:30:00Z",
                    component: { type: "application", name: "my-service", version: "2.0.0" },
                    tools: {
                        components: [
                            { type: "application", name: "syft", version: "0.90.0" },
                        ],
                    },
                },
                components: [],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);
            expect(res.body.toolName).toBe("syft");
            expect(res.body.sourceName).toBe("my-service");

            const db = getTestDb();
            const sbomRecord = await db
                .select()
                .from(schema.sboms)
                .where(eq(schema.sboms.id, res.body.id));

            expect(sbomRecord[0]!.toolName).toBe("syft");
            expect(sbomRecord[0]!.toolVersion).toBe("0.90.0");
            expect(sbomRecord[0]!.sourceName).toBe("my-service");
            expect(sbomRecord[0]!.sourceType).toBe("application");
            expect(sbomRecord[0]!.serialNumber).toBe("urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79");
        });
    });

    describe("component properties", () => {
        it("should store component properties linked to component", async () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: { type: "application", name: "my-app", version: "1.0.0" },
                },
                components: [
                    {
                        type: "library",
                        name: "prop-lib",
                        version: "1.0.0",
                        purl: "pkg:npm/prop-lib@1.0.0",
                        properties: [
                            { name: "cdx:npm:package:path", value: "node_modules/prop-lib" },
                            { name: "cdx:npm:package:development", value: "false" },
                        ],
                    },
                ],
            };

            const res = await request(app)
                .post(uploadUrl)
                .set(makeHeaders(testData))
                .send(sbom);

            expect(res.status).toBe(201);

            const db = getTestDb();
            const components = await db
                .select()
                .from(schema.components)
                .where(eq(schema.components.sbomId, res.body.id));

            const component = components.find(c => c.name === "prop-lib");

            const props = await db
                .select()
                .from(schema.componentProperties)
                .where(eq(schema.componentProperties.componentId, component!.id));

            expect(props).toHaveLength(2);
            expect(props.map(p => p.name).sort()).toEqual([
                "cdx:npm:package:development",
                "cdx:npm:package:path",
            ]);
        });
    });
});
