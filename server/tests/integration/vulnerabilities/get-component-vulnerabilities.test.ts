import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { randomUUID } from "crypto";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

describe("GET /api/vulnerabilities/component/:componentId", () => {
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

    /**
     * Seed a component on an image the given org is running. Ownership travels
     * `component → sbom → image`, and since images are cluster-scoped the
     * image row itself names its org — see `db/tenancy.ts`.
     */
    async function seedOwnedComponent(
        orgId: string,
        clusterId: string,
        name: string,
        options: { workloadName?: string } = {},
    ) {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, orgId, clusterId, {
            workloadName: options.workloadName ?? name,
        });
        const sbom = await createSbom(db, { imageId: image.id });
        const [component] = await db
            .insert(schema.components)
            .values({
                sbomId: sbom.id,
                name,
                version: "4.17.20",
                type: "library",
            })
            .returning();
        return component!;
    }

    it("returns empty list when component has no linked vulnerabilities", async () => {
        const component = await seedOwnedComponent(testData.org.id, testData.cluster.id, "no-such-package");

        const response = await request(app).get(`/api/vulnerabilities/component/${component.id}`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            componentId: component.id,
            count: 0,
            vulnerabilities: [],
        });
    });

    it("returns list with linked vulnerabilities when seeded", async () => {
        const db = getTestDb();
        const component = await seedOwnedComponent(testData.org.id, testData.cluster.id, "lodash");

        const [vuln] = await db
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    {
                        vulnId: "CVE-2024-99999",
                        source: "osv",
                        summary: "Prototype pollution in lodash",
                        severityLevel: "HIGH",
                        cvssScore: 7.5,
                    },
                ]),
            )
            .returning();

        await db.insert(schema.componentVulnerabilities).values({
            componentId: component.id,
            vulnerabilityId: vuln!.id,
            matchedBy: "purl",
            matchConfidence: "exact",
        });

        const response = await request(app).get(`/api/vulnerabilities/component/${component.id}`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.componentId).toBe(component.id);
        expect(response.body.count).toBe(1);
        expect(response.body.vulnerabilities).toHaveLength(1);
        expect(response.body.vulnerabilities[0]).toMatchObject({
            vulnId: "CVE-2024-99999",
            summary: "Prototype pollution in lodash",
            severityLevel: "HIGH",
        });
    });

    /**
     * The regression this endpoint existed without: knowing a component UUID
     * was enough to read which advisories had landed on another tenant's image.
     */
    it("404s on a component belonging to another org", async () => {
        const db = getTestDb();
        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-comp" });
        const component = await seedOwnedComponent(other.org.id, other.cluster.id, "lodash");

        const response = await request(app).get(`/api/vulnerabilities/component/${component.id}`).set(authHeaders());

        expect(response.status).toBe(404);
    });

    /**
     * A component on an image no `workload_containers` row points at — the
     * upload-before-inventory case. Since images are cluster-scoped it is
     * visible to the org that owns the image row, and to nobody else.
     */
    it("serves a component of an undeployed image to its owning org only", async () => {
        const db = getTestDb();
        const sbom = await createSbom(db, {
            imageId: (
                await db
                    .insert(schema.images)
                    .values({
                        orgId: testData.org.id,
                        clusterId: testData.cluster.id,
                        digest: `sha256:${randomUUID().replace(/-/g, "").padEnd(64, "0")}`,
                    })
                    .returning()
            )[0]!.id,
        });
        const [component] = await db
            .insert(schema.components)
            .values({
                sbomId: sbom.id,
                name: "orphan",
                version: "1.0.0",
                type: "library",
            })
            .returning();

        const owner = await request(app).get(`/api/vulnerabilities/component/${component!.id}`).set(authHeaders());
        expect(owner.status).toBe(200);

        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-orphan" });
        const theirs = await request(app)
            .get(`/api/vulnerabilities/component/${component!.id}`)
            .set(
                createInternalHeaders({
                    id: other.user.id,
                    email: other.user.email,
                    orgId: other.org.id,
                    orgName: other.org.name,
                    orgSlug: other.org.slug,
                }),
            );
        expect(theirs.status).toBe(404);
    });

    it("refuses an unauthenticated caller", async () => {
        const response = await request(app).get(`/api/vulnerabilities/component/${randomUUID()}`);

        expect(response.status).toBe(401);
    });
});
