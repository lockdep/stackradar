import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
// Schema only — importing src/db/index.js here would eagerly connect the
// app's client before the test container's DATABASE_URL is set.
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createImage,
    createOrgWithOwner,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * GET /api/clusters/:id/components — the Packages tab.
 *
 * The contract under test: one row per (name, version) across every scanned
 * image of ONE cluster, spread counted by image and workload, findings counted
 * once per identity however many images carry them, and nothing from any
 * other cluster or org ever visible.
 */
describe("cluster components (packages tab)", () => {
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

    function authHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    async function component(sbomId: string, name: string, version: string, type = "library") {
        const db = getTestDb();
        const [c] = await db
            .insert(schema.components)
            .values({
                sbomId,
                name,
                version,
                purl: `pkg:npm/${name}@${version}`,
                type,
                isDirect: true,
            })
            .returning();
        return c!;
    }

    /** Two images in the cluster, one package shared between them. */
    async function seedTwoImages() {
        const db = getTestDb();
        const { org, cluster } = testData;

        const a = await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
        });
        const sbomA = await createSbom(db, { imageId: a.image.id });

        const b = await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "worker",
            digest: "sha256:" + "b".repeat(64),
        });
        const sbomB = await createSbom(db, { imageId: b.image.id });

        const lodashA = await component(sbomA.id, "lodash", "4.17.21");
        const lodashB = await component(sbomB.id, "lodash", "4.17.21");
        await component(sbomA.id, "react", "18.0.0");
        await component(sbomB.id, "express", "4.18.0");
        // Not a library — must never list.
        await component(sbomA.id, "my-app", "1.0.0", "application");

        return { sbomA, sbomB, lodashA, lodashB, imageA: a.image, imageB: b.image };
    }

    it("aggregates one row per name+version, with image and workload spread", async () => {
        await seedTwoImages();

        const response = await request(app).get(`/api/clusters/${testData.cluster.id}/components`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(3);
        expect(response.body.packages).toHaveLength(3);

        // Ordered by name: express, lodash, react.
        const [express, lodash, react] = response.body.packages;
        expect(express).toMatchObject({ name: "express", version: "4.18.0", imageCount: 1, workloadCount: 1 });
        // lodash is in both images — one row, spread of two, not two rows.
        expect(lodash).toMatchObject({ name: "lodash", version: "4.17.21", imageCount: 2, workloadCount: 2 });
        expect(react).toMatchObject({ name: "react", version: "18.0.0", imageCount: 1, workloadCount: 1 });
    });

    it("counts a finding once per identity, not once per image carrying it", async () => {
        const db = getTestDb();
        const { lodashA, lodashB } = await seedTwoImages();

        const [vuln] = await db
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    {
                        vulnId: "CVE-2024-0001",
                        source: "osv",
                        severityLevel: "high",
                        cvssScore: 8.1,
                        aliases: null,
                    },
                ]),
            )
            .returning();

        // The same advisory on both copies of lodash — plus an unconfirmed
        // match, which is not a finding and must not count.
        for (const c of [lodashA, lodashB]) {
            await db.insert(schema.componentVulnerabilities).values({
                componentId: c.id,
                vulnerabilityId: vuln!.id,
                matchedBy: "purl",
                matchType: "direct",
                matchConfidence: "exact",
            });
        }
        const [unconfirmedVuln] = await db
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    { vulnId: "CVE-2024-0002", source: "osv", severityLevel: "critical", aliases: null },
                ]),
            )
            .returning();
        await db.insert(schema.componentVulnerabilities).values({
            componentId: lodashA.id,
            vulnerabilityId: unconfirmedVuln!.id,
            matchedBy: "name",
            matchType: "direct",
            matchConfidence: "unconfirmed",
        });

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/components?search=lodash`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.packages).toHaveLength(1);
        expect(response.body.packages[0].vulnCounts).toEqual({
            critical: 0,
            high: 1,
            medium: 0,
            low: 0,
        });
    });

    it("searches by name and purl, server-side", async () => {
        await seedTwoImages();

        const byName = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/components?search=expr`)
            .set(authHeaders());
        expect(byName.status).toBe(200);
        expect(byName.body.total).toBe(1);
        expect(byName.body.packages[0].name).toBe("express");

        const byPurl = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/components?search=pkg:npm/react`)
            .set(authHeaders());
        expect(byPurl.status).toBe(200);
        expect(byPurl.body.packages.map((p: { name: string }) => p.name)).toEqual(["react"]);
    });

    it("paginates with a total that survives the page window", async () => {
        await seedTwoImages();

        const page1 = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/components?limit=2&offset=0`)
            .set(authHeaders());
        expect(page1.status).toBe(200);
        expect(page1.body.total).toBe(3);
        expect(page1.body.packages.map((p: { name: string }) => p.name)).toEqual(["express", "lodash"]);

        const page2 = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/components?limit=2&offset=2`)
            .set(authHeaders());
        expect(page2.body.packages.map((p: { name: string }) => p.name)).toEqual(["react"]);
        expect(page2.body.total).toBe(3);
    });

    it("never lists another cluster's packages", async () => {
        const db = getTestDb();
        await seedTwoImages();

        // Same org, different cluster — its packages are its own (ADR 0006).
        const otherCluster = await createCluster(db, testData.org.id);
        const other = await seedRunningImage(db, testData.org.id, otherCluster.id, {
            digest: "sha256:" + "c".repeat(64),
        });
        const otherSbom = await createSbom(db, { imageId: other.image.id });
        await component(otherSbom.id, "left-pad", "1.3.0");

        const response = await request(app).get(`/api/clusters/${testData.cluster.id}/components`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.packages.map((p: { name: string }) => p.name)).not.toContain("left-pad");
    });

    it("404s for a cluster the org does not own", async () => {
        const db = getTestDb();
        const stranger = await createOrgWithOwner(db);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/components`)
            .set(
                createInternalHeaders({
                    id: stranger.user.id,
                    email: stranger.user.email,
                    orgId: stranger.org.id,
                    orgName: stranger.org.name,
                    orgSlug: stranger.org.slug,
                }),
            );

        expect(response.status).toBe(404);
    });

    it("returns an empty page, not 404, for a cluster with no scans", async () => {
        const response = await request(app).get(`/api/clusters/${testData.cluster.id}/components`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ packages: [], total: 0, limit: 50, offset: 0 });
    });

    describe("occurrences (the count drill-down)", () => {
        it("lists the images and workloads carrying one package version, with links' ids", async () => {
            const seeded = await seedTwoImages();

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences?name=lodash&version=4.17.21`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images).toHaveLength(2);
            expect(response.body.images.map((i: { id: string }) => i.id).sort()).toEqual(
                [seeded.imageA.id, seeded.imageB.id].sort(),
            );
            expect(response.body.workloads.map((w: { workloadName: string }) => w.workloadName).sort()).toEqual([
                "api",
                "worker",
            ]);
            for (const workload of response.body.workloads) {
                expect(workload.containerId).toBeTruthy();
                expect(workload.namespaceName).toBe("default");
            }
        });

        it("scopes to the exact version — a sibling version's images do not list", async () => {
            await seedTwoImages();

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences?name=react&version=18.0.0`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            // react is only in image A / workload "api".
            expect(response.body.images).toHaveLength(1);
            expect(response.body.workloads.map((w: { workloadName: string }) => w.workloadName)).toEqual(["api"]);

            const wrongVersion = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences?name=react&version=17.0.0`)
                .set(authHeaders());
            expect(wrongVersion.body).toEqual({ images: [], workloads: [] });
        });

        it("lists a scanned-but-uninventoried image with zero workloads, not nothing", async () => {
            const db = getTestDb();
            // An image with an SBOM but no workload_containers row — uploaded
            // before any inventory referenced it.
            const orphan = await createImage(db, testData.org.id, testData.cluster.id, {
                digest: "sha256:" + "d".repeat(64),
            });
            const sbom = await createSbom(db, { imageId: orphan.id });
            await component(sbom.id, "left-pad", "1.3.0");

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences?name=left-pad&version=1.3.0`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images.map((i: { id: string }) => i.id)).toEqual([orphan.id]);
            expect(response.body.workloads).toEqual([]);
        });

        it("never lists another cluster's occurrences of the same package", async () => {
            const db = getTestDb();
            await seedTwoImages();

            const otherCluster = await createCluster(db, testData.org.id);
            const other = await seedRunningImage(db, testData.org.id, otherCluster.id, {
                digest: "sha256:" + "c".repeat(64),
                workloadName: "elsewhere",
            });
            const otherSbom = await createSbom(db, { imageId: other.image.id });
            await component(otherSbom.id, "lodash", "4.17.21");

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences?name=lodash&version=4.17.21`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images).toHaveLength(2);
            expect(response.body.workloads.map((w: { workloadName: string }) => w.workloadName)).not.toContain(
                "elsewhere",
            );
        });

        it("404s for a cluster the org does not own", async () => {
            const db = getTestDb();
            const stranger = await createOrgWithOwner(db);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences?name=lodash&version=4.17.21`)
                .set(
                    createInternalHeaders({
                        id: stranger.user.id,
                        email: stranger.user.email,
                        orgId: stranger.org.id,
                        orgName: stranger.org.name,
                        orgSlug: stranger.org.slug,
                    }),
                );

            expect(response.status).toBe(404);
        });

        it("400s without a package name", async () => {
            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/components/occurrences`)
                .set(authHeaders());

            expect(response.status).toBe(400);
        });
    });
});
