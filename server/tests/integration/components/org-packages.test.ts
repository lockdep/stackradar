import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createOrgWithOwner,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * GET /api/components — the org-wide Packages page.
 *
 * The cluster tab's contract (`clusters/cluster-components.test.ts`) with
 * the scope widened to every cluster of the caller's org: one row per
 * (name, version) across all of them, the spread now also counted by
 * cluster, occurrences naming the cluster each image and workload is in,
 * and nothing from another org ever visible. Under ADR 0006 a digest in
 * two clusters is two images, so a package in both counts two images here
 * — the same two the cluster tabs count between them.
 */
describe("org-wide packages", () => {
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

    async function component(sbomId: string, name: string, version: string, type = "library") {
        const [c] = await getTestDb()
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

    async function finding(componentId: string, vulnId: string, severityLevel: string) {
        const db = getTestDb();
        const existing = await db
            .select()
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, vulnId));
        const vuln =
            existing[0] ??
            (
                await db
                    .insert(schema.vulnerabilities)
                    .values(withFindingIdentity([{ vulnId, source: "osv", severityLevel, aliases: null }]))
                    .returning()
            )[0]!;
        await db.insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId: vuln.id,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
        });
    }

    /** One running image in each of two clusters of the org, each with lodash. */
    async function seedTwoClusters() {
        const db = getTestDb();
        const { org, cluster: clusterA } = testData;
        const clusterB = await createCluster(db, org.id);

        const a = await seedRunningImage(db, org.id, clusterA.id, {
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
        });
        const b = await seedRunningImage(db, org.id, clusterB.id, {
            workloadName: "worker",
            digest: "sha256:" + "b".repeat(64),
        });
        const sbomA = await createSbom(db, { imageId: a.image.id });
        const sbomB = await createSbom(db, { imageId: b.image.id });

        const lodashA = await component(sbomA.id, "lodash", "4.17.21");
        const lodashB = await component(sbomB.id, "lodash", "4.17.21");
        const reactA = await component(sbomA.id, "react", "18.0.0");
        // Not a library — must never list.
        await component(sbomB.id, "my-app", "1.0.0", "application");

        return { clusterA, clusterB, imageA: a.image, imageB: b.image, lodashA, lodashB, reactA };
    }

    it("folds one package version across clusters into one row, counting the spread by cluster too", async () => {
        await seedTwoClusters();

        const response = await request(app).get("/api/components").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(2);
        const [lodash, react] = response.body.packages;
        expect(lodash).toMatchObject({
            name: "lodash",
            version: "4.17.21",
            imageCount: 2,
            workloadCount: 2,
            clusterCount: 2,
        });
        expect(react).toMatchObject({
            name: "react",
            version: "18.0.0",
            imageCount: 1,
            workloadCount: 1,
            clusterCount: 1,
        });
    });

    it("counts a finding once per identity across clusters, and a tab's clusterCount is 1", async () => {
        const { clusterA, lodashA, lodashB } = await seedTwoClusters();
        await finding(lodashA.id, "CVE-2024-0001", "high");
        await finding(lodashB.id, "CVE-2024-0001", "high");

        const [org, tabA] = await Promise.all([
            request(app).get("/api/components?search=lodash").set(authHeaders()),
            request(app).get(`/api/clusters/${clusterA.id}/components?search=lodash`).set(authHeaders()),
        ]);

        expect(org.status).toBe(200);
        expect(org.body.packages[0].vulnCounts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
        expect(tabA.body.packages[0]).toMatchObject({ clusterCount: 1, imageCount: 1 });
    });

    it("searches and pages with the cluster tab's parameters", async () => {
        await seedTwoClusters();

        const byName = await request(app).get("/api/components?search=react").set(authHeaders());
        expect(byName.body.total).toBe(1);
        expect(byName.body.packages[0].name).toBe("react");

        const paged = await request(app).get("/api/components?limit=1&offset=1").set(authHeaders());
        expect(paged.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
        expect(paged.body.packages.map((p: { name: string }) => p.name)).toEqual(["react"]);
    });

    it("narrows rows, spread, finding counts and occurrences to one side's images under ?control=", async () => {
        const { imageB, lodashA, lodashB } = await seedTwoClusters();
        await getTestDb().update(schema.images).set({ control: "third-party" }).where(eq(schema.images.id, imageB.id));
        await finding(lodashA.id, "CVE-2024-0001", "high");
        await finding(lodashB.id, "CVE-2024-0002", "critical");

        const [thirdParty, yours, unknown, occurrences] = await Promise.all([
            request(app).get("/api/components?control=third-party").set(authHeaders()),
            request(app).get("/api/components?control=yours").set(authHeaders()),
            request(app).get("/api/components?control=nonsense").set(authHeaders()),
            request(app)
                .get("/api/components/occurrences?name=lodash&version=4.17.21&control=third-party")
                .set(authHeaders()),
        ]);

        expect(thirdParty.body.total).toBe(1);
        expect(thirdParty.body.packages[0]).toMatchObject({
            name: "lodash",
            imageCount: 1,
            clusterCount: 1,
            vulnCounts: { critical: 1, high: 0, medium: 0, low: 0 },
        });

        // `yours` is everything not third-party, the undecided included.
        expect(yours.body.packages.map((p: { name: string }) => p.name)).toEqual(["lodash", "react"]);
        expect(yours.body.packages[0]).toMatchObject({
            imageCount: 1,
            vulnCounts: { critical: 0, high: 1, medium: 0, low: 0 },
        });

        // A stale or hand-edited value is no filter, never a 400.
        expect(unknown.status).toBe(200);
        expect(unknown.body.total).toBe(2);

        expect(occurrences.body.images.map((i: { id: string }) => i.id)).toEqual([imageB.id]);
    });

    it("lists the scope's ecosystems off its purls and narrows to one under ?ecosystem=", async () => {
        const { imageA } = await seedTwoClusters();
        const [sbomA] = await getTestDb().select().from(schema.sboms).where(eq(schema.sboms.imageId, imageA.id));
        await getTestDb()
            .insert(schema.components)
            .values([
                {
                    sbomId: sbomA!.id,
                    name: "libssl3t64",
                    version: "3.0.13",
                    purl: "pkg:deb/ubuntu/libssl3t64@3.0.13?arch=amd64",
                    type: "library",
                },
                {
                    sbomId: sbomA!.id,
                    name: "zlib1g",
                    version: "1.3",
                    purl: "pkg:deb/debian/zlib1g@1.3",
                    type: "library",
                },
                // No purl: in the list, in no ecosystem.
                { sbomId: sbomA!.id, name: "mystery", version: "1", purl: null, type: "library" },
            ]);

        const [options, npm, ubuntu, unreadable] = await Promise.all([
            request(app).get("/api/components/ecosystems").set(authHeaders()),
            request(app).get("/api/components?ecosystem=npm").set(authHeaders()),
            request(app).get("/api/components?ecosystem=deb/ubuntu").set(authHeaders()),
            request(app).get("/api/components?ecosystem=n%25m").set(authHeaders()),
        ]);

        // Most rows first; the two deb distros are two ecosystems.
        expect(options.body.ecosystems).toEqual(["npm", "deb/debian", "deb/ubuntu"]);
        expect(npm.body.packages.map((p: { name: string }) => p.name)).toEqual(["lodash", "react"]);
        expect(ubuntu.body.total).toBe(1);
        expect(ubuntu.body.packages[0].name).toBe("libssl3t64");

        // A value outside the shape is no filter, never a 400 or a wildcard.
        expect(unreadable.status).toBe(200);
        expect(unreadable.body.total).toBe(5);
    });

    it("narrows to the rows whose own counts have a finding in the band under ?severity=", async () => {
        const { imageB, lodashA, lodashB, reactA } = await seedTwoClusters();
        await finding(lodashA.id, "CVE-2024-0001", "high");
        await finding(lodashB.id, "CVE-2024-0002", "critical");
        await finding(reactA.id, "CVE-2024-0003", "medium");

        const get = (query: string) => request(app).get(`/api/components?${query}`).set(authHeaders());
        const names = (body: { packages: { name: string }[] }) => body.packages.map((p) => p.name);

        const [critical, either, unknown] = await Promise.all([
            get("severity=critical"),
            get("severity=medium,critical"),
            get("severity=catastrophic"),
        ]);
        expect(critical.body.total).toBe(1);
        expect(names(critical.body)).toEqual(["lodash"]);
        // The row is the whole package, not only its critical findings.
        expect(critical.body.packages[0].vulnCounts).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });
        expect(names(either.body)).toEqual(["lodash", "react"]);
        // Nothing readable is no filter.
        expect(unknown.body.total).toBe(2);

        // Under the images filter the band is asked of the same images the
        // counts are: lodash's critical is in the third-party image only.
        await getTestDb().update(schema.images).set({ control: "third-party" }).where(eq(schema.images.id, imageB.id));
        const yours = await get("severity=critical&control=yours");
        expect(yours.body.total).toBe(0);
    });

    it("never lists another org's packages", async () => {
        const db = getTestDb();
        await seedTwoClusters();

        const stranger = await createOrgWithOwner(db);
        const strangerCluster = await createCluster(db, stranger.org.id);
        const other = await seedRunningImage(db, stranger.org.id, strangerCluster.id, {
            digest: "sha256:" + "c".repeat(64),
            workloadName: "elsewhere",
        });
        const otherSbom = await createSbom(db, { imageId: other.image.id });
        await component(otherSbom.id, "lodash", "4.17.21");
        await component(otherSbom.id, "left-pad", "1.3.0");

        const response = await request(app).get("/api/components").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(2);
        expect(response.body.packages.map((p: { name: string }) => p.name)).toEqual(["lodash", "react"]);
        expect(response.body.packages[0]).toMatchObject({ imageCount: 2, clusterCount: 2 });
    });

    it("returns an empty page for an org with no scans", async () => {
        const response = await request(app).get("/api/components").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ packages: [], total: 0, limit: 50, offset: 0 });
    });

    describe("occurrences", () => {
        it("names the cluster of every image and workload, across clusters", async () => {
            const seeded = await seedTwoClusters();

            const response = await request(app)
                .get("/api/components/occurrences?name=lodash&version=4.17.21")
                .set(authHeaders());

            expect(response.status).toBe(200);
            const byImage = Object.fromEntries(
                response.body.images.map((i: { id: string; clusterId: string; clusterName: string }) => [
                    i.id,
                    { clusterId: i.clusterId, clusterName: i.clusterName },
                ]),
            );
            expect(byImage[seeded.imageA.id]).toEqual({
                clusterId: seeded.clusterA.id,
                clusterName: seeded.clusterA.name,
            });
            expect(byImage[seeded.imageB.id]).toEqual({
                clusterId: seeded.clusterB.id,
                clusterName: seeded.clusterB.name,
            });

            const byWorkload = Object.fromEntries(
                response.body.workloads.map((w: { workloadName: string; clusterId: string }) => [
                    w.workloadName,
                    w.clusterId,
                ]),
            );
            expect(byWorkload).toEqual({ api: seeded.clusterA.id, worker: seeded.clusterB.id });
        });

        it("treats version as identity, not a wildcard", async () => {
            await seedTwoClusters();

            const response = await request(app)
                .get("/api/components/occurrences?name=lodash&version=4.17.20")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ images: [], workloads: [] });
        });

        it("400s without a name", async () => {
            const response = await request(app).get("/api/components/occurrences").set(authHeaders());
            expect(response.status).toBe(400);
        });
    });
});
