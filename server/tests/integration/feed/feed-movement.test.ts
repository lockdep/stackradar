/**
 * `GET /api/feed/movement` — the Dashboard's "New on running images" block:
 * the org's scan and move events in a fixed window, folded per image by
 * `lib/recent-movement.ts`, worst first. A first scan is inventory, not
 * change; a scan that only removed findings is footer context, not a row.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createImage,
    createSbom,
    seedRunningImage,
    withFindingIdentity,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { ActivityEventType } from "../../../src/db/schema/remediation.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const bands = (critical = 0, high = 0, medium = 0, low = 0, unscored = 0) => ({
    critical,
    high,
    medium,
    low,
    unscored,
});

import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("GET /api/feed/movement", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;
    let clusterId: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        // No plan: the 30-day window the clamp test reads against (reads are not gated).
        testData = await createOrgWithOwner(db, {}, { plan: "free" });
        clusterId = (await createCluster(db, testData.org.id, { name: "prod-eu" })).id;
    });

    function headers() {
        return createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id });
    }

    async function event(
        type: ActivityEventType,
        ageMs: number,
        imageId: string | null,
        payload: Record<string, unknown>,
        opts: { orgId?: string } = {},
    ) {
        await getTestDb()
            .insert(schema.activityEvents)
            .values({
                orgId: opts.orgId ?? testData.org.id,
                clusterId,
                type,
                imageId,
                payload,
                createdAt: new Date(Date.now() - ageMs),
            });
    }

    it("folds scans and moves into one row per image, worst first, and names the image", async () => {
        const db = getTestDb();
        const nginx = await seedRunningImage(db, testData.org.id, clusterId, {
            image: await createImage(db, testData.org.id, clusterId, {
                repository: "registry.k8s.io/ingress-nginx/controller",
            }),
            namespace: "ingress",
            workloadName: "ingress-nginx",
            imageTag: "1.9.4",
        });
        const redis = await seedRunningImage(db, testData.org.id, clusterId, {
            image: await createImage(db, testData.org.id, clusterId, { repository: "docker.io/library/redis" }),
            namespace: "cache",
            workloadName: "redis",
            imageTag: "7.2",
        });
        const quiet = await seedRunningImage(db, testData.org.id, clusterId, { workloadName: "quiet" });

        // Two scan events on the same image in the window: summed, KEV ids deduplicated.
        await event("scan.findings-changed", 2 * DAY, nginx.image.id, {
            cause: "mirror",
            repository: "registry.k8s.io/ingress-nginx/controller",
            digest: nginx.image.digest,
            containerCount: 3,
            containers: [
                { namespace: "ingress", workloadKind: "Deployment", workloadName: "ingress-nginx" },
                { namespace: "ingress", workloadKind: "Deployment", workloadName: "ingress-nginx-canary" },
            ],
            addedBySeverity: bands(1, 1),
            removedBySeverity: bands(0, 0, 1),
            added: [
                { vulnId: "CVE-2025-1974", severityLevel: "critical", kevListed: true },
                { vulnId: "CVE-2025-0002", severityLevel: "high", kevListed: false },
            ],
            removed: [{ vulnId: "CVE-2023-0009", severityLevel: "medium", kevListed: false }],
        });
        await event("scan.findings-changed", 3 * HOUR, nginx.image.id, {
            cause: "mirror",
            repository: "registry.k8s.io/ingress-nginx/controller",
            addedBySeverity: bands(0, 1),
            removedBySeverity: bands(),
            added: [{ vulnId: "CVE-2025-1974", severityLevel: "high", kevListed: true }],
            removed: [],
        });
        // A move that brought findings: the row is the *to* image.
        await event("container.image-changed", 1 * DAY, redis.image.id, {
            namespace: "cache",
            workloadKind: "Deployment",
            workloadName: "redis",
            repository: "docker.io/library/redis",
            to: { imageId: redis.image.id, digest: redis.image.digest, tag: "7.2", ref: "redis:7.2" },
            delta: {
                introduced: 3,
                resolved: 1,
                introducedKev: 0,
                introducedBySeverity: bands(0, 0, 3),
                resolvedBySeverity: bands(0, 0, 0, 1),
            },
        });
        // Inventory, not change.
        await event("scan.findings-changed", 1 * DAY, quiet.image.id, {
            cause: "first-scan",
            addedBySeverity: bands(9),
            added: [{ vulnId: "CVE-2024-0099", severityLevel: "critical", kevListed: true }],
            removed: [],
        });
        // Only unscored arrivals: not a change worth a row, as on the Feed page.
        await event("scan.findings-changed", 1 * DAY, quiet.image.id, {
            cause: "mirror",
            addedBySeverity: bands(0, 0, 0, 0, 40),
            added: [],
            removed: [],
        });
        // A digest nothing runs any more: its newest scan says so, and neither
        // that rescan nor the earlier one, when it still ran, is a row.
        await event("scan.findings-changed", 1 * DAY, quiet.image.id, {
            cause: "mirror",
            containerCount: 0,
            containers: [],
            addedBySeverity: bands(7),
            removedBySeverity: bands(0, 0, 0, 9),
            added: [],
            removed: [],
        });
        await event("scan.findings-changed", 2 * DAY, quiet.image.id, {
            cause: "mirror",
            containerCount: 2,
            addedBySeverity: bands(3),
            removedBySeverity: bands(),
            added: [],
            removed: [],
        });
        // Only removals: counted in the footer, never a row.
        await event("scan.findings-changed", 1 * DAY, quiet.image.id, {
            cause: "mirror",
            addedBySeverity: bands(),
            removedBySeverity: bands(0, 2),
            added: [],
            removed: [],
        });
        // An unmeasured move says nothing about findings.
        await event("container.image-changed", 1 * DAY, quiet.image.id, {
            delta: null,
            deltaUnavailable: "to-unscanned",
        });
        // Outside the window.
        await event("scan.findings-changed", 9 * DAY, quiet.image.id, {
            cause: "mirror",
            addedBySeverity: bands(5),
            added: [],
            removed: [],
        });

        const res = await request(app).get("/api/feed/movement").set(headers());

        expect(res.status).toBe(200);
        expect(res.body.days).toBe(7);
        expect(res.body.totalImages).toBe(2);
        expect(res.body.images.map((i: { imageId: string }) => i.imageId)).toEqual([nginx.image.id, redis.image.id]);

        const [first, second] = res.body.images;
        expect(first).toMatchObject({
            repository: "registry.k8s.io/ingress-nginx/controller",
            clusterName: "prod-eu",
            tag: "1.9.4",
            // Where it runs is the live inventory's answer, not the events'.
            runsIn: [
                expect.objectContaining({
                    namespace: "ingress",
                    workloadName: "ingress-nginx",
                    containerId: expect.any(String),
                }),
            ],
            addedCount: 3,
            added: bands(1, 2),
            kev: 1,
            kevVulnIds: ["CVE-2025-1974"],
            resolvedCount: 1,
            containers: 3,
            scans: 2,
            moves: 0,
        });
        expect(new Date(first.lastAt).getTime()).toBeGreaterThan(Date.now() - 4 * HOUR);
        expect(second).toMatchObject({
            repository: "docker.io/library/redis",
            tag: "7.2",
            addedCount: 3,
            added: bands(0, 0, 3),
            kev: 0,
            containers: 1,
            scans: 0,
            moves: 1,
        });
        // `severity=` keeps the images that gained a finding in any named band, before the cap.
        const critical = await request(app).get("/api/feed/movement?severity=critical,high").set(headers());
        expect(critical.body.images.map((i: { imageId: string }) => i.imageId)).toEqual([nginx.image.id]);
        expect(critical.body.totalImages).toBe(1);
        expect(critical.body.totalImagesAnySeverity).toBe(2);
        // A value naming no band is no filter, not an error.
        const junk = await request(app).get("/api/feed/movement?severity=nope").set(headers());
        expect(junk.body.totalImages).toBe(2);

        // Footer: everything that left, across rows and non-rows alike.
        expect(res.body.resolved).toEqual({ count: 4, bySeverity: bands(0, 2, 1, 1) });
    });

    it("narrows to the images one side controls, counting under the filter", async () => {
        const db = getTestDb();
        const ours = await seedRunningImage(db, testData.org.id, clusterId, { workloadName: "api" });
        const upstream = await seedRunningImage(db, testData.org.id, clusterId, { workloadName: "redis" });
        await db.update(schema.images).set({ control: "third-party" }).where(eq(schema.images.id, upstream.image.id));
        for (const image of [ours.image, upstream.image]) {
            await event("scan.findings-changed", 2 * HOUR, image.id, {
                cause: "mirror",
                containerCount: 1,
                addedBySeverity: bands(0, 1),
                removedBySeverity: bands(),
                added: [],
                removed: [],
            });
        }

        const thirdParty = await request(app).get("/api/feed/movement?control=third-party").set(headers());
        expect(thirdParty.body.images.map((i: { imageId: string }) => i.imageId)).toEqual([upstream.image.id]);
        expect(thirdParty.body.images[0].control).toBe("third-party");
        expect(thirdParty.body.totalImages).toBe(1);
        expect(thirdParty.body.totalImagesAnySeverity).toBe(1);

        const yours = await request(app).get("/api/feed/movement?control=yours").set(headers());
        expect(yours.body.images.map((i: { imageId: string }) => i.imageId)).toEqual([ours.image.id]);

        const all = await request(app).get("/api/feed/movement?control=nonsense").set(headers());
        expect(all.body.totalImages).toBe(2);
    });

    itCloud("clamps the window to the plan and never sees another org", async () => {
        const stranger = await createOrgWithOwner(getTestDb());
        const theirs = await seedRunningImage(
            getTestDb(),
            stranger.org.id,
            (await createCluster(getTestDb(), stranger.org.id)).id,
        );
        await event(
            "scan.findings-changed",
            1 * DAY,
            theirs.image.id,
            { cause: "mirror", addedBySeverity: bands(1), added: [], removed: [] },
            { orgId: stranger.org.id },
        );

        const res = await request(app).get("/api/feed/movement").query({ days: 90 }).set(headers());
        expect(res.status).toBe(200);
        expect(res.body.images).toEqual([]);
        expect(res.body.totalImages).toBe(0);
        // A free plan keeps 30 days.
        expect(res.body.days).toBe(30);
        expect(res.body.historyDays).toBe(30);
    });

    it("rejects a malformed window", async () => {
        expect((await request(app).get("/api/feed/movement").query({ days: "soon" }).set(headers())).status).toBe(400);
        expect((await request(app).get("/api/feed/movement").query({ days: 0 }).set(headers())).status).toBe(400);
    });

    describe("GET /api/feed/movement/:imageId/findings", () => {
        const line = (
            vulnId: string,
            severityLevel: string,
            packageName: string,
            extra: Record<string, unknown> = {},
        ) => ({
            key: `deb|${packageName}|${vulnId}`,
            vulnId,
            packageName,
            packageType: "deb",
            packageVersion: "1.0.0",
            severityLevel,
            riskScore: 10,
            kevListed: false,
            fixedVersion: null,
            ...extra,
        });

        async function advisory(vulnId: string, cvss: number) {
            const [row] = await getTestDb()
                .insert(schema.vulnerabilities)
                .values(
                    withFindingIdentity([
                        {
                            vulnId,
                            source: "osv",
                            cvssScore: cvss,
                            severityLevel: cvss >= 9 ? "critical" : "high",
                            aliases: [],
                        },
                    ]),
                )
                .returning();
            return row!;
        }

        async function scanned(imageId: string) {
            const db = getTestDb();
            const sbom = await createSbom(db, { imageId });
            await db.insert(schema.vulnerabilityScanRuns).values({
                orgId: testData.org.id,
                imageId,
                sbomId: sbom.id,
                trigger: "sbom_upload",
                status: "success",
            });
            return sbom;
        }

        async function finding(sbomId: string, packageName: string, vulnerabilityId: string) {
            const db = getTestDb();
            const [component] = await db
                .insert(schema.components)
                .values({
                    sbomId,
                    name: packageName,
                    version: "1.0.0",
                    purl: `pkg:deb/debian/${packageName}@1.0.0`,
                    type: "library",
                    isDirect: true,
                })
                .returning();
            await db.insert(schema.componentVulnerabilities).values({
                componentId: component!.id,
                vulnerabilityId,
                matchedBy: "purl",
                matchType: "direct",
                matchConfidence: "exact",
            });
        }

        it("lists what the scans added, newest verdict per key, and what a move introduced, worst first", async () => {
            const db = getTestDb();
            const image = await seedRunningImage(db, testData.org.id, clusterId, {
                workloadName: "api",
                imageTag: "1.27",
            });
            // The digest this image replaced: the move is diffed against it now.
            const previous = await createImage(db, testData.org.id, clusterId, { repository: image.image.repository });
            const sbomPrev = await scanned(previous.id);
            const sbomNow = await scanned(image.image.id);
            const stays = await advisory("CVE-2026-0002", 7.5);
            const introduced = await advisory("CVE-2026-0003", 9.8);
            await finding(sbomPrev.id, "zlib", stays.id);
            await finding(sbomNow.id, "zlib", stays.id);
            await finding(sbomNow.id, "curl", introduced.id);

            await event("container.image-changed", 2 * DAY, image.image.id, {
                namespace: "default",
                workloadKind: "Deployment",
                workloadName: "api",
                from: { imageId: previous.id, digest: previous.digest, tag: "1.26", ref: "acme/api:1.26" },
                to: { imageId: image.image.id, digest: image.image.digest, tag: "1.27", ref: "acme/api:1.27" },
                delta: {
                    introduced: 1,
                    resolved: 0,
                    introducedKev: 0,
                    introducedBySeverity: bands(1),
                    resolvedBySeverity: bands(),
                },
            });
            // The advisory database then moved twice under the running image.
            await event("scan.findings-changed", 1 * DAY, image.image.id, {
                cause: "mirror",
                containerCount: 1,
                addedBySeverity: bands(0, 1, 1),
                removedBySeverity: bands(),
                added: [
                    line("CVE-2026-0010", "high", "openssl", { kevListed: true, fixedVersion: "3.0.2" }),
                    line("CVE-2026-0011", "medium", "libxml2"),
                ],
                removed: [],
            });
            await event("scan.findings-changed", 2 * HOUR, image.image.id, {
                cause: "mirror",
                containerCount: 1,
                addedBySeverity: bands(0, 0, 0, 1),
                removedBySeverity: bands(0, 0, 1),
                added: [line("CVE-2026-0012", "low", "bash")],
                removed: [line("CVE-2026-0011", "medium", "libxml2")],
            });

            const res = await request(app).get(`/api/feed/movement/${image.image.id}/findings`).set(headers());

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                imageId: image.image.id,
                days: 7,
                total: 3,
                partial: false,
                unmeasuredMoves: 0,
            });
            expect(
                res.body.findings.map((f: { vulnId: string; via: string; packageName: string }) => [
                    f.vulnId,
                    f.via,
                    f.packageName,
                ]),
            ).toEqual([
                ["CVE-2026-0003", "move", "curl"],
                ["CVE-2026-0010", "scan", "openssl"],
                ["CVE-2026-0012", "scan", "bash"],
            ]);
            expect(res.body.findings[1]).toMatchObject({
                kevListed: true,
                fixedVersion: "3.0.2",
                severityLevel: "high",
            });
        });

        it("says how long a scan arrival had already been in the image, across the digests that carried it, and nothing for a move", async () => {
            const db = getTestDb();
            const image = await seedRunningImage(db, testData.org.id, clusterId, {
                workloadName: "api",
                imageTag: "1.27",
            });
            const previous = await createImage(db, testData.org.id, clusterId, { repository: image.image.repository });
            const sbomPrev = await scanned(previous.id);
            const sbomNow = await scanned(image.image.id);
            // On both digests all along; the mirror only caught up yesterday.
            const late = await advisory("CVE-2026-0030", 7.5);
            await finding(sbomPrev.id, "zlib", late.id);
            await finding(sbomNow.id, "zlib", late.id);
            // New with the tag.
            const moved = await advisory("CVE-2026-0031", 9.8);
            await finding(sbomNow.id, "curl", moved.id);

            await db
                .update(schema.clusters)
                .set({ firstInventoryAt: new Date(Date.now() - 200 * DAY) })
                .where(eq(schema.clusters.id, clusterId));
            const started = new Date(Date.now() - 20 * DAY);
            const switched = new Date(Date.now() - 2 * DAY);
            const slot = {
                orgId: testData.org.id,
                clusterId,
                namespace: "default",
                workloadKind: "Deployment",
                workloadName: "api",
                containerName: "app",
            };
            await db.insert(schema.workloadContainerHistory).values([
                {
                    ...slot,
                    imageId: previous.id,
                    digest: previous.digest,
                    imageRef: "acme/api:1.26",
                    startedAt: started,
                    endedAt: switched,
                },
                {
                    ...slot,
                    imageId: image.image.id,
                    digest: image.image.digest,
                    imageRef: "acme/api:1.27",
                    startedAt: switched,
                    endedAt: null,
                },
            ]);

            await event("container.image-changed", 2 * DAY, image.image.id, {
                namespace: "default",
                workloadKind: "Deployment",
                workloadName: "api",
                from: { imageId: previous.id, digest: previous.digest, tag: "1.26", ref: "acme/api:1.26" },
                to: { imageId: image.image.id, digest: image.image.digest, tag: "1.27", ref: "acme/api:1.27" },
                delta: {
                    introduced: 1,
                    resolved: 0,
                    introducedKev: 0,
                    introducedBySeverity: bands(1),
                    resolvedBySeverity: bands(),
                },
            });
            await event("scan.findings-changed", 1 * DAY, image.image.id, {
                cause: "mirror",
                containerCount: 1,
                addedBySeverity: bands(0, 1),
                removedBySeverity: bands(),
                added: [line("CVE-2026-0030", "high", "zlib", { key: "library|zlib|CVE-2026-0030" })],
                removed: [],
            });

            const res = await request(app).get(`/api/feed/movement/${image.image.id}/findings`).set(headers());
            expect(res.status).toBe(200);
            const byId = new Map<string, Record<string, unknown>>(
                res.body.findings.map((f: { vulnId: string }) => [f.vulnId, f]),
            );

            const scan = byId.get("CVE-2026-0030")!;
            expect(scan.via).toBe("scan");
            expect(new Date(scan.presentSince as string).getTime()).toBe(started.getTime());
            expect(scan.presentSinceIsLowerBound).toBe(false);

            const move = byId.get("CVE-2026-0031")!;
            expect(move.via).toBe("move");
            expect(move.presentSince).toBeNull();

            // The block's own "Running in" rows: this digest only, per container.
            const block = await request(app).get("/api/feed/movement").set(headers());
            const row = block.body.images.find((i: { imageId: string }) => i.imageId === image.image.id);
            expect(row.runsIn).toHaveLength(1);
            expect(new Date(row.runsIn[0].onImageSince).getTime()).toBe(switched.getTime());
            expect(row.runsIn[0].onImageSinceIsLowerBound).toBe(false);
        });

        it("says the list is partial when a move's from-digest cannot be diffed or a head list was cut", async () => {
            const db = getTestDb();
            const image = await seedRunningImage(db, testData.org.id, clusterId);
            await scanned(image.image.id);
            await event("container.image-changed", 1 * DAY, image.image.id, {
                from: { imageId: "00000000-0000-4000-8000-000000000000", digest: "sha256:gone", tag: "1", ref: "r" },
                to: { imageId: image.image.id, digest: image.image.digest, tag: "2", ref: "r" },
                delta: { introducedBySeverity: bands(0, 3) },
            });
            await event("scan.findings-changed", 1 * HOUR, image.image.id, {
                cause: "mirror",
                addedBySeverity: bands(2),
                added: [line("CVE-2026-0020", "critical", "openssl")],
                removed: [],
            });

            const res = await request(app).get(`/api/feed/movement/${image.image.id}/findings`).set(headers());
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ total: 1, partial: true, unmeasuredMoves: 1 });
            expect(res.body.findings[0].vulnId).toBe("CVE-2026-0020");
        });

        it("unfolds empty for another org's image and rejects a malformed id", async () => {
            const stranger = await createOrgWithOwner(getTestDb());
            const theirs = await seedRunningImage(
                getTestDb(),
                stranger.org.id,
                (await createCluster(getTestDb(), stranger.org.id)).id,
            );
            await event(
                "scan.findings-changed",
                1 * DAY,
                theirs.image.id,
                {
                    cause: "mirror",
                    addedBySeverity: bands(1),
                    added: [line("CVE-2026-0030", "critical", "x")],
                    removed: [],
                },
                { orgId: stranger.org.id },
            );

            const res = await request(app).get(`/api/feed/movement/${theirs.image.id}/findings`).set(headers());
            expect(res.status).toBe(200);
            expect(res.body.findings).toEqual([]);
            expect(res.body.total).toBe(0);

            expect((await request(app).get("/api/feed/movement/not-a-uuid/findings").set(headers())).status).toBe(400);
        });
    });
});
