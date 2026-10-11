import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createImage,
    createSbom,
    seedRunningImage,
    withFindingIdentity,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("Metrics snapshots", () => {
    let app: Express;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
    });

    function authHeaders(user: { id: string; email: string }, org: { id: string; name: string; slug: string }) {
        return createInternalHeaders({
            id: user.id,
            email: user.email,
            orgId: org.id,
            orgName: org.name,
            orgSlug: org.slug,
        });
    }

    // -------------------------------------------------------------------------
    // The breakdown: a filtered trend is a sum of the captured cells
    // -------------------------------------------------------------------------

    describe("filtered snapshots (?control=, ?tier=)", () => {
        async function seedTwoSides() {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db);
            const cluster = await createCluster(db, org.id);

            const ours = await createImage(db, org.id, cluster.id, { digest: `sha256:${"a".repeat(64)}` });
            const theirs = await createImage(db, org.id, cluster.id, { digest: `sha256:${"b".repeat(64)}` });
            await db.update(schema.images).set({ control: "built" }).where(eq(schema.images.id, ours.id));
            await db.update(schema.images).set({ control: "third-party" }).where(eq(schema.images.id, theirs.id));
            await seedRunningImage(db, org.id, cluster.id, { image: ours, workloadName: "api" });
            await seedRunningImage(db, org.id, cluster.id, { image: theirs, workloadName: "proxy" });
            await seedRunningImage(db, org.id, cluster.id, { image: theirs, workloadName: "proxy-2" });

            const oursSbom = await createSbom(db, { imageId: ours.id });
            const theirsSbom = await createSbom(db, { imageId: theirs.id });
            const [appPkg, osPkg, theirOsPkg] = await db
                .insert(schema.components)
                .values([
                    { sbomId: oursSbom.id, name: "lodash", version: "4.17.20", type: "library", tier: "application" },
                    { sbomId: oursSbom.id, name: "openssl", version: "3.0.1", type: "library", tier: "os" },
                    { sbomId: theirsSbom.id, name: "zlib", version: "1.2.11", type: "library", tier: "os" },
                ])
                .returning();

            const [critical, high, medium] = await db
                .insert(schema.vulnerabilities)
                .values(
                    withFindingIdentity([
                        {
                            vulnId: "CVE-2024-1001",
                            source: "osv",
                            summary: "c",
                            severityLevel: "CRITICAL",
                            cvssScore: 9.8,
                        },
                        { vulnId: "CVE-2024-1002", source: "osv", summary: "h", severityLevel: "HIGH", cvssScore: 7.5 },
                        {
                            vulnId: "CVE-2024-1003",
                            source: "osv",
                            summary: "m",
                            severityLevel: "MEDIUM",
                            cvssScore: 5.0,
                        },
                    ]),
                )
                .returning();
            await db.insert(schema.componentVulnerabilities).values([
                { componentId: appPkg!.id, vulnerabilityId: critical!.id, matchedBy: "purl", matchConfidence: "exact" },
                { componentId: osPkg!.id, vulnerabilityId: high!.id, matchedBy: "purl", matchConfidence: "exact" },
                {
                    componentId: theirOsPkg!.id,
                    vulnerabilityId: medium!.id,
                    matchedBy: "purl",
                    matchConfidence: "exact",
                },
            ]);

            const headers = authHeaders(user, org);
            const captured = await request(app).post("/api/metrics/snapshots").set(headers);
            expect(captured.status).toBe(201);
            return { db, org, headers };
        }

        it("keeps the unfiltered series whole, and leaves the breakdown on the server", async () => {
            const { headers } = await seedTwoSides();

            const res = await request(app).get("/api/metrics/snapshots").set(headers);

            expect(res.body).toHaveLength(1);
            expect(res.body[0]).toMatchObject({
                totalVulnerabilities: 3,
                criticalVulnerabilities: 1,
                highVulnerabilities: 1,
                mediumVulnerabilities: 1,
                totalWorkloads: 3,
                totalComponents: 3,
            });
            expect(res.body[0]).not.toHaveProperty("breakdown");
        });

        it("sums only the side asked for", async () => {
            const { headers } = await seedTwoSides();

            const yours = await request(app).get("/api/metrics/snapshots?control=yours").set(headers);
            const theirs = await request(app).get("/api/metrics/snapshots?control=third-party").set(headers);

            expect(yours.body[0]).toMatchObject({
                totalVulnerabilities: 2,
                criticalVulnerabilities: 1,
                highVulnerabilities: 1,
                mediumVulnerabilities: 0,
                totalWorkloads: 1,
                totalComponents: 2,
            });
            expect(theirs.body[0]).toMatchObject({
                totalVulnerabilities: 1,
                mediumVulnerabilities: 1,
                criticalVulnerabilities: 0,
                totalWorkloads: 2,
                totalComponents: 1,
            });
            expect(yours.body[0].riskScore + theirs.body[0].riskScore).toBeGreaterThan(0);
        });

        it("sums only the lens bucket asked for, and both filters compose", async () => {
            const { headers } = await seedTwoSides();

            const application = await request(app).get("/api/metrics/snapshots?tier=application,main").set(headers);
            const base = await request(app).get("/api/metrics/snapshots?tier=os,runtime").set(headers);
            const oursBase = await request(app)
                .get("/api/metrics/snapshots?tier=os,runtime&control=yours")
                .set(headers);

            expect(application.body[0]).toMatchObject({
                totalVulnerabilities: 1,
                criticalVulnerabilities: 1,
                totalComponents: 1,
            });
            expect(base.body[0]).toMatchObject({
                totalVulnerabilities: 2,
                highVulnerabilities: 1,
                mediumVulnerabilities: 1,
                totalComponents: 2,
            });
            expect(oursBase.body[0]).toMatchObject({
                totalVulnerabilities: 1,
                highVulnerabilities: 1,
                mediumVulnerabilities: 0,
                totalComponents: 1,
            });
        });

        it("leaves rows captured before the breakdown out of a filtered series only", async () => {
            const { db, org, headers } = await seedTwoSides();
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: new Date(Date.now() - 60 * 60 * 1000),
                totalVulnerabilities: 9,
                totalWorkloads: 9,
                totalComponents: 9,
            });

            const all = await request(app).get("/api/metrics/snapshots").set(headers);
            const filtered = await request(app).get("/api/metrics/snapshots?control=yours").set(headers);

            expect(all.body).toHaveLength(2);
            expect(filtered.body).toHaveLength(1);
            expect(filtered.body[0].totalVulnerabilities).toBe(2);
        });
    });

    // -------------------------------------------------------------------------
    // GET /api/metrics/snapshots
    // -------------------------------------------------------------------------

    describe("GET /api/metrics/snapshots", () => {
        it("returns 200 with an empty array when no snapshots exist", async () => {
            const { user, org } = await createOrgWithOwner(getTestDb());

            const res = await request(app).get("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        it("returns snapshots for the org ordered by capturedAt", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db);

            const t1 = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const t2 = new Date(Date.now() - 1 * 60 * 60 * 1000);
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: t1,
                totalVulnerabilities: 5,
                totalWorkloads: 2,
                totalComponents: 100,
            });
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: t2,
                totalVulnerabilities: 6,
                totalWorkloads: 3,
                totalComponents: 110,
            });

            const res = await request(app).get("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(2);
            expect(res.body[0].totalVulnerabilities).toBe(5);
            expect(res.body[1].totalVulnerabilities).toBe(6);
        });

        it("does not return snapshots from another org", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, { email: "a@test.com" }, { slug: "org-a" });
            const { org: otherOrg } = await createOrgWithOwner(db, { email: "b@test.com" }, { slug: "org-b" });

            await db
                .insert(schema.orgMetricsSnapshots)
                .values({ orgId: otherOrg.id, totalVulnerabilities: 99, totalWorkloads: 99, totalComponents: 99 });

            const res = await request(app).get("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        it("filters out snapshots older than the requested days window", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db);

            const recent = new Date(Date.now() - 1 * 60 * 60 * 1000);
            const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: recent,
                totalVulnerabilities: 1,
                totalWorkloads: 1,
                totalComponents: 1,
            });
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: old,
                totalVulnerabilities: 99,
                totalWorkloads: 99,
                totalComponents: 99,
            });

            const res = await request(app).get("/api/metrics/snapshots?days=30").set(authHeaders(user, org));

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0].totalVulnerabilities).toBe(1);
        });

        it("requires auth", async () => {
            const res = await request(app).get("/api/metrics/snapshots");
            expect(res.status).toBe(401);
        });

        /* Trend depth is a plan axis (`historyDays`, config/plans.ts): the
           `?days` window is clamped to the plan, so a free org asking for a
           year gets its 30-day window, not a global maximum. */
        itCloud("clamps the days window to the plan's history window", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, {}, { plan: "free" }); // 30 days
            const inside = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
            const beyond = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: inside,
                totalVulnerabilities: 1,
                totalWorkloads: 1,
                totalComponents: 1,
            });
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: beyond,
                totalVulnerabilities: 99,
                totalWorkloads: 99,
                totalComponents: 99,
            });

            const res = await request(app).get("/api/metrics/snapshots?days=365").set(authHeaders(user, org));

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0].totalVulnerabilities).toBe(1);
        });

        it("lets a pro org read past the free window", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, {}, { plan: "pro" }); // 365 days
            const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: org.id,
                capturedAt: old,
                totalVulnerabilities: 7,
                totalWorkloads: 1,
                totalComponents: 1,
            });

            // The plan rides the internal headers (the BFF forwards the
            // validated org's plan as X-Org-Plan), so it is set explicitly here.
            const headers = createInternalHeaders({
                id: user.id,
                email: user.email,
                orgId: org.id,
                orgName: org.name,
                orgSlug: org.slug,
                orgPlan: "pro",
            });
            const res = await request(app).get("/api/metrics/snapshots?days=365").set(headers);

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0].totalVulnerabilities).toBe(7);
        });
    });

    // -------------------------------------------------------------------------
    // History retention sweep — per-plan windows
    // -------------------------------------------------------------------------

    describe("metricsService.cleanup", () => {
        itCloud("deletes each org's history past its own plan window", async () => {
            const db = getTestDb();
            const { metricsService } = await import("../../../src/services/metrics.service.js");
            const { org: freeOrg } = await createOrgWithOwner(
                db,
                { email: "free@test.com" },
                { slug: "free-org", plan: "free" },
            );
            const { org: proOrg } = await createOrgWithOwner(
                db,
                { email: "pro@test.com" },
                { slug: "pro-org", plan: "pro" },
            );

            // 45 days old: past free's 30-day window, inside pro's 365.
            const aged = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: freeOrg.id,
                capturedAt: aged,
                totalVulnerabilities: 1,
                totalWorkloads: 1,
                totalComponents: 1,
            });
            await db.insert(schema.orgMetricsSnapshots).values({
                orgId: proOrg.id,
                capturedAt: aged,
                totalVulnerabilities: 2,
                totalWorkloads: 2,
                totalComponents: 2,
            });

            const deleted = await metricsService.cleanup();

            expect(deleted).toBe(1);
            const freeRows = await db
                .select()
                .from(schema.orgMetricsSnapshots)
                .where(eq(schema.orgMetricsSnapshots.orgId, freeOrg.id));
            const proRows = await db
                .select()
                .from(schema.orgMetricsSnapshots)
                .where(eq(schema.orgMetricsSnapshots.orgId, proOrg.id));
            expect(freeRows).toHaveLength(0);
            expect(proRows).toHaveLength(1);
        });

        itCloud("sweeps scan runs on the same plan clock", async () => {
            const db = getTestDb();
            const { metricsService } = await import("../../../src/services/metrics.service.js");
            const { org } = await createOrgWithOwner(db, {}, { plan: "free" });
            const cluster = await createCluster(db, org.id);
            const image = await createImage(db, org.id, cluster.id);

            const aged = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            await db.insert(schema.vulnerabilityScanRuns).values([
                { orgId: org.id, imageId: image.id, trigger: "manual", status: "success", createdAt: aged },
                { orgId: org.id, imageId: image.id, trigger: "manual", status: "success" },
            ]);

            await metricsService.cleanup();

            const runs = await db
                .select()
                .from(schema.vulnerabilityScanRuns)
                .where(eq(schema.vulnerabilityScanRuns.orgId, org.id));
            expect(runs).toHaveLength(1);
        });

        itCloud("sweeps activity events on the same plan clock", async () => {
            const db = getTestDb();
            const { metricsService } = await import("../../../src/services/metrics.service.js");
            const { org: freeOrg } = await createOrgWithOwner(
                db,
                { email: "free@test.com" },
                { slug: "free-org", plan: "free" },
            );
            const { org: proOrg } = await createOrgWithOwner(
                db,
                { email: "pro@test.com" },
                { slug: "pro-org", plan: "pro" },
            );

            // 45 days old: past free's 30-day window, inside pro's 365.
            const aged = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            await db.insert(schema.activityEvents).values([
                { orgId: freeOrg.id, type: "issue.created", createdAt: aged },
                { orgId: freeOrg.id, type: "issue.created" },
                { orgId: proOrg.id, type: "issue.created", createdAt: aged },
            ]);

            await metricsService.cleanup();

            const freeEvents = await db
                .select()
                .from(schema.activityEvents)
                .where(eq(schema.activityEvents.orgId, freeOrg.id));
            const proEvents = await db
                .select()
                .from(schema.activityEvents)
                .where(eq(schema.activityEvents.orgId, proOrg.id));
            expect(freeEvents).toHaveLength(1);
            expect(proEvents).toHaveLength(1);
        });

        itCloud("sweeps closed container intervals on the plan clock, and never open ones", async () => {
            const db = getTestDb();
            const { metricsService } = await import("../../../src/services/metrics.service.js");
            const { org: freeOrg } = await createOrgWithOwner(
                db,
                { email: "free@test.com" },
                { slug: "free-org", plan: "free" },
            );
            const cluster = await createCluster(db, freeOrg.id);

            const aged = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
            const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
            const interval = (digest: string, endedAt: Date | null) => ({
                orgId: freeOrg.id,
                clusterId: cluster.id,
                namespace: "prod",
                workloadName: "web",
                containerName: "api",
                digest,
                imageRef: `acme/api@${digest}`,
                startedAt: ancient,
                endedAt,
            });
            await db.insert(schema.workloadContainerHistory).values([
                interval(`sha256:${"a".repeat(64)}`, aged),
                interval(`sha256:${"b".repeat(64)}`, new Date()),
                // Started long ago and still running: current, never swept.
                interval(`sha256:${"c".repeat(64)}`, null),
            ]);

            await metricsService.cleanup();

            const left = await db
                .select({ digest: schema.workloadContainerHistory.digest })
                .from(schema.workloadContainerHistory)
                .where(eq(schema.workloadContainerHistory.orgId, freeOrg.id));
            expect(left.map((r) => r.digest).sort()).toEqual([`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`]);
        });
    });

    // -------------------------------------------------------------------------
    // POST /api/metrics/snapshots (trigger capture)
    // -------------------------------------------------------------------------

    describe("POST /api/metrics/snapshots", () => {
        it("returns 201 with the captured snapshot", async () => {
            const { user, org } = await createOrgWithOwner(getTestDb());

            const res = await request(app).post("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(201);
            expect(res.body.orgId).toBe(org.id);
            expect(res.body.totalVulnerabilities).toBe(0);
            expect(res.body.totalWorkloads).toBe(0);
            expect(res.body.totalComponents).toBe(0);
        });

        /* The `type = 'project'` filter this replaces existed to keep group
           rows out of the count. With namespaces and workloads as separate
           tables there is nothing to filter — a namespace is not a workload,
           so it cannot be miscounted as one. */
        it("counts running containers, and a namespace is not one of them", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db);
            const cluster = await createCluster(db, org.id);

            await seedRunningImage(db, org.id, cluster.id, { namespace: "prod", workloadName: "svc-a" });
            await seedRunningImage(db, org.id, cluster.id, { namespace: "prod", workloadName: "svc-b" });

            const res = await request(app).post("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(201);
            expect(res.body.totalWorkloads).toBe(2);
        });

        /* Components are counted per image, not per place the image runs. The
           old query counted them once per project, so one base image across
           twenty workloads inflated the total twentyfold. */
        it("counts an image's components once however many workloads run it", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db);
            const cluster = await createCluster(db, org.id);
            const image = await createImage(db, org.id, cluster.id);
            const sbom = await createSbom(db, { imageId: image.id });

            await db.insert(schema.components).values([
                { sbomId: sbom.id, name: "express", version: "4.18.0", type: "library" },
                { sbomId: sbom.id, name: "lodash", version: "4.17.21", type: "library" },
            ]);

            for (const ns of ["a", "b", "c"]) {
                await seedRunningImage(db, org.id, cluster.id, { namespace: ns, image });
            }

            const res = await request(app).post("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(201);
            expect(res.body.totalWorkloads).toBe(3);
            expect(res.body.totalComponents).toBe(2);
        });

        /* Since images became cluster-scoped, counting predicates are plain
           `images.org_id` checks: an uploaded-but-not-yet-inventoried image
           counts for its owning org even before anything runs it. */
        it("counts components of the org's image even when nothing runs it", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db);
            const cluster = await createCluster(db, org.id);
            const orphan = await createImage(db, org.id, cluster.id);
            const sbom = await createSbom(db, { imageId: orphan.id });
            await db
                .insert(schema.components)
                .values([{ sbomId: sbom.id, name: "stale-dep", version: "1.0.0", type: "library" }]);

            const res = await request(app).post("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(201);
            expect(res.body.totalComponents).toBe(1);
        });

        it("counts vulnerabilities only for the org's own images", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, { email: "a@test.com" }, { slug: "org-a" });
            const cluster = await createCluster(db, org.id);
            const { org: otherOrg } = await createOrgWithOwner(db, { email: "b@test.com" }, { slug: "org-b" });
            const otherCluster = await createCluster(db, otherOrg.id);

            const running = await createImage(db, org.id, cluster.id, { digest: `sha256:${"7".repeat(64)}` });
            const orphan = await createImage(db, otherOrg.id, otherCluster.id, { digest: `sha256:${"8".repeat(64)}` });
            await seedRunningImage(db, org.id, cluster.id, { image: running });

            const currentSbom = await createSbom(db, { imageId: running.id });
            const oldSbom = await createSbom(db, { imageId: orphan.id });

            const [compCurrent] = await db
                .insert(schema.components)
                .values({ sbomId: currentSbom.id, name: "lodash", version: "4.17.20", type: "library" })
                .returning();
            const [compOld] = await db
                .insert(schema.components)
                .values({ sbomId: oldSbom.id, name: "lodash", version: "4.17.19", type: "library" })
                .returning();

            const [vuln1] = await db
                .insert(schema.vulnerabilities)
                .values(
                    withFindingIdentity([
                        {
                            vulnId: "CVE-2024-0001",
                            source: "osv",
                            summary: "Vuln 1",
                            severityLevel: "HIGH",
                            cvssScore: 7.5,
                        },
                    ]),
                )
                .returning();
            const [vuln2] = await db
                .insert(schema.vulnerabilities)
                .values(
                    withFindingIdentity([
                        {
                            vulnId: "CVE-2024-0002",
                            source: "osv",
                            summary: "Vuln 2",
                            severityLevel: "MEDIUM",
                            cvssScore: 5.0,
                        },
                    ]),
                )
                .returning();

            await db.insert(schema.componentVulnerabilities).values({
                componentId: compCurrent!.id,
                vulnerabilityId: vuln1!.id,
                matchedBy: "purl",
                matchConfidence: "exact",
            });
            await db.insert(schema.componentVulnerabilities).values({
                componentId: compOld!.id,
                vulnerabilityId: vuln2!.id,
                matchedBy: "purl",
                matchConfidence: "exact",
            });

            const res = await request(app).post("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(201);
            expect(res.body.totalVulnerabilities).toBe(1);
        });

        it("does not count data from other orgs", async () => {
            const db = getTestDb();
            const { user, org } = await createOrgWithOwner(db, { email: "a@test.com" }, { slug: "org-a" });
            const { org: otherOrg } = await createOrgWithOwner(db, { email: "b@test.com" }, { slug: "org-b" });

            const otherCluster = await createCluster(db, otherOrg.id);
            await seedRunningImage(db, otherOrg.id, otherCluster.id, { workloadName: "a" });
            await seedRunningImage(db, otherOrg.id, otherCluster.id, { workloadName: "b" });

            const res = await request(app).post("/api/metrics/snapshots").set(authHeaders(user, org));

            expect(res.status).toBe(201);
            expect(res.body.totalWorkloads).toBe(0);
        });

        it("requires auth", async () => {
            const res = await request(app).post("/api/metrics/snapshots");
            expect(res.status).toBe(401);
        });
    });
});
