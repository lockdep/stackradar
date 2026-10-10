/**
 * The activity feed's write side on the inventory path —
 * docs/proposals/activity-feed.md §1, §2, §4, §5, §8.
 *
 * A report is a full set replacement, so the "before" state is destroyed by
 * the write; these tests post successive reports and assert that the
 * interval table and the event log remember what the live table forgot.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { asc, eq } from "drizzle-orm";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    createSbom,
    seedRunningImage,
    withFindingIdentity,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { backfillMoveDeltas } from "../../../src/repositories/container-history.repository.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function container(digest: string, overrides: Record<string, unknown> = {}) {
    return {
        name: "api",
        init: false,
        imageRef: `ghcr.io/acme/api@${digest}`,
        imageDigest: digest,
        imageTag: "1.26",
        registry: "ghcr.io",
        repository: "acme/api",
        runningPods: 3,
        ...overrides,
    };
}

function workload(containers: unknown[], overrides: Record<string, unknown> = {}) {
    return {
        kind: "Deployment",
        name: "web",
        release: null,
        application: null,
        runningPods: 3,
        firstStartedAt: "2026-07-02T10:00:00.000Z",
        containers,
        ...overrides,
    };
}

function report(workloads: unknown[], namespace = "prod") {
    return {
        version: 3,
        reportedAt: "2026-09-06T09:14:22.113Z",
        informerSynced: true,
        ownerMetadataCollected: true,
        releases: [],
        applications: [],
        namespaces: [{ name: namespace, labels: {}, workloads }],
    };
}

describe("inventory → workload_container_history and container events", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;
    let clusterId: string;
    let clusterKey: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await createOrgWithOwner(db);
        const cluster = await createCluster(db, testData.org.id);
        clusterId = cluster.id;
        ({ rawKey: clusterKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id));
    });

    async function post(body: object) {
        const res = await request(app).post("/v1/inventory").set(createApiKeyHeaders(clusterKey)).send(body);
        expect(res.status).toBe(200);
        return res;
    }

    function intervals() {
        return getTestDb()
            .select()
            .from(schema.workloadContainerHistory)
            .where(eq(schema.workloadContainerHistory.clusterId, clusterId))
            .orderBy(asc(schema.workloadContainerHistory.startedAt), asc(schema.workloadContainerHistory.digest));
    }

    async function events() {
        const rows = await getTestDb()
            .select()
            .from(schema.activityEvents)
            .where(eq(schema.activityEvents.orgId, testData.org.id))
            .orderBy(asc(schema.activityEvents.createdAt), asc(schema.activityEvents.type));
        return rows.filter((e) => e.type.startsWith("container."));
    }

    it("opens an interval and emits container.appeared for a slot's first report", async () => {
        await post(report([workload([container(DIGEST_A)])]));

        const rows = await intervals();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            namespace: "prod",
            workloadKind: "Deployment",
            workloadName: "web",
            containerName: "api",
            digest: DIGEST_A,
            repository: "acme/api",
            imageTag: "1.26",
            endedAt: null,
        });
        expect(rows[0]!.workloadId).not.toBeNull();
        expect(rows[0]!.imageId).not.toBeNull();

        const evs = await events();
        expect(evs).toHaveLength(1);
        expect(evs[0]).toMatchObject({
            type: "container.appeared",
            clusterId,
            payload: expect.objectContaining({
                namespace: "prod",
                workloadName: "web",
                containerName: "api",
                repository: "acme/api",
                from: null,
                to: expect.objectContaining({ digest: DIGEST_A, tag: "1.26" }),
                imageNew: true,
            }),
        });
    });

    it("an unchanged re-report writes nothing", async () => {
        await post(report([workload([container(DIGEST_A)])]));
        await post(report([workload([container(DIGEST_A)])]));

        expect(await intervals()).toHaveLength(1);
        expect(await events()).toHaveLength(1);
    });

    it("a move closes A, opens B and emits container.image-changed", async () => {
        await post(report([workload([container(DIGEST_A, { imageTag: "1.26" })])]));
        await post(report([workload([container(DIGEST_B, { imageTag: "1.27" })])]));

        const rows = await intervals();
        expect(rows).toHaveLength(2);
        const [a, b] = rows;
        expect(a).toMatchObject({ digest: DIGEST_A, imageTag: "1.26" });
        expect(a!.endedAt).not.toBeNull();
        expect(b).toMatchObject({ digest: DIGEST_B, imageTag: "1.27", endedAt: null });
        // The interval closed at the report that first did not see it.
        expect(a!.endedAt!.getTime()).toBe(b!.startedAt.getTime());

        const evs = await events();
        expect(evs.map((e) => e.type)).toEqual(["container.appeared", "container.image-changed"]);
        expect(evs[1]!.payload).toMatchObject({
            from: expect.objectContaining({ digest: DIGEST_A, tag: "1.26" }),
            to: expect.objectContaining({ digest: DIGEST_B, tag: "1.27" }),
            imageNew: true,
            imageGone: true,
            mutableTag: false,
            // Neither digest has an SBOM: no delta, and the payload says why
            // rather than reporting a zero.
            delta: null,
            deltaUnavailable: "from-unscanned",
        });
    });

    it("a mutable tag re-pull is a move that says so", async () => {
        await post(report([workload([container(DIGEST_A, { imageTag: "latest" })])]));
        await post(report([workload([container(DIGEST_B, { imageTag: "latest" })])]));

        const evs = await events();
        expect(evs[1]).toMatchObject({
            type: "container.image-changed",
            payload: expect.objectContaining({ mutableTag: true }),
        });
    });

    it("the same digest under a new tag is container.retagged and updates the open interval", async () => {
        await post(report([workload([container(DIGEST_A, { imageTag: "1.26" })])]));
        await post(report([workload([container(DIGEST_A, { imageTag: "1.27" })])]));

        const rows = await intervals();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ digest: DIGEST_A, imageTag: "1.27", endedAt: null });

        const evs = await events();
        expect(evs.map((e) => e.type)).toEqual(["container.appeared", "container.retagged"]);
        expect(evs[1]!.payload).toMatchObject({
            from: expect.objectContaining({ digest: DIGEST_A, tag: "1.26" }),
            to: expect.objectContaining({ digest: DIGEST_A, tag: "1.27" }),
        });
    });

    it("a rollout is two open intervals, then a move when the old digest stops serving", async () => {
        await post(report([workload([container(DIGEST_A)])]));
        await post(report([workload([container(DIGEST_A, { runningPods: 1 }), container(DIGEST_B, { runningPods: 2 })])]));

        let rows = await intervals();
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.endedAt === null)).toBe(true);
        let evs = await events();
        expect(evs.map((e) => e.type)).toEqual(["container.appeared", "container.rollout-started"]);
        expect(evs[1]!.payload).toMatchObject({
            from: expect.objectContaining({ digest: DIGEST_A }),
            to: expect.objectContaining({ digest: DIGEST_B }),
        });

        await post(report([workload([container(DIGEST_B, { runningPods: 3 })])]));

        rows = await intervals();
        expect(rows.find((r) => r.digest === DIGEST_A)!.endedAt).not.toBeNull();
        expect(rows.find((r) => r.digest === DIGEST_B)!.endedAt).toBeNull();
        evs = await events();
        expect(evs.map((e) => e.type)).toEqual([
            "container.appeared",
            "container.rollout-started",
            "container.image-changed",
        ]);
        expect(evs[2]!.payload).toMatchObject({
            from: expect.objectContaining({ digest: DIGEST_A }),
            to: expect.objectContaining({ digest: DIGEST_B }),
            imageGone: true,
        });
    });

    it("a slot that disappears closes its interval and emits container.removed", async () => {
        await post(report([workload([container(DIGEST_A)])]));
        await post(report([]));

        const rows = await intervals();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.endedAt).not.toBeNull();
        // The workload was pruned; the row survives with its names intact.
        expect(rows[0]!.workloadId).toBeNull();
        expect(rows[0]).toMatchObject({ workloadName: "web", containerName: "api", digest: DIGEST_A });

        const evs = await events();
        expect(evs.map((e) => e.type)).toEqual(["container.appeared", "container.removed"]);
        expect(evs[1]!.payload).toMatchObject({
            from: expect.objectContaining({ digest: DIGEST_A }),
            to: null,
            imageGone: true,
        });
    });

    it("a slot that comes back after a prune reattaches to the recreated workload", async () => {
        await post(report([workload([container(DIGEST_A)])]));
        await post(report([]));
        await post(report([workload([container(DIGEST_A)])]));

        const rows = await intervals();
        expect(rows).toHaveLength(2);
        const open = rows.find((r) => r.endedAt === null)!;
        const [recreated] = await getTestDb().select().from(schema.workloads);
        expect(open.workloadId).toBe(recreated!.id);
    });

    describe("noise", () => {
        it("elides appear/remove for CronJob pods unless the image is new to the cluster", async () => {
            // First run: the image is new to the cluster, so the appearance counts.
            await post(report([workload([container(DIGEST_A)], { kind: "CronJob", name: "nightly" })]));
            expect((await events()).map((e) => e.type)).toEqual(["container.appeared"]);

            // The pod finishes and the slot vanishes; the digest stays known
            // via nothing else, so this *is* the image going away — kept.
            await post(report([]));
            expect((await events()).map((e) => e.type)).toEqual(["container.appeared", "container.removed"]);
        });

        it("elides a CronJob pod's churn when another slot keeps the image running", async () => {
            const web = workload([container(DIGEST_A)]);
            const cron = workload([container(DIGEST_A)], { kind: "CronJob", name: "nightly" });
            await post(report([web]));
            await post(report([web, cron]));
            await post(report([web]));
            await post(report([web, cron]));

            expect((await events()).map((e) => e.type)).toEqual(["container.appeared"]);
            // History still has every interval, so the elision is display-only.
            expect(await intervals()).toHaveLength(3);
        });

        it("never elides a CronJob's image change", async () => {
            const cron = (d: string) => workload([container(d)], { kind: "CronJob", name: "nightly" });
            await post(report([workload([container(DIGEST_A)]), cron(DIGEST_A)]));
            await post(report([workload([container(DIGEST_A)]), cron(DIGEST_B)]));

            // Both appearances count on the first report — the digest was
            // new to the cluster — and the CronJob's move is never elided.
            const evs = await events();
            expect(evs.map((e) => e.type)).toEqual([
                "container.appeared",
                "container.appeared",
                "container.image-changed",
            ]);
        });
    });

    describe("backfill", () => {
        it("opens intervals for containers that predate the table, dated from first_seen_at, without events", async () => {
            const db = getTestDb();
            const seeded = await seedRunningImage(db, testData.org.id, clusterId, {
                namespace: "prod",
                workloadName: "web",
                containerName: "api",
                digest: DIGEST_A,
                imageTag: "1.26",
            });

            await post(report([workload([container(DIGEST_A, {
                imageTag: "1.26",
                imageRef: seeded.container.imageRef,
            })])]));

            const rows = await intervals();
            expect(rows).toHaveLength(1);
            expect(rows[0]!.startedAt.getTime()).toBe(seeded.container.firstSeenAt.getTime());
            expect(rows[0]!.endedAt).toBeNull();
            expect(await events()).toHaveLength(0);
        });
    });

    describe("the move carries its finding delta", () => {
        async function advisory(vulnId: string, cvss: number) {
            const [row] = await getTestDb()
                .insert(schema.vulnerabilities)
                .values(withFindingIdentity([{
                    vulnId,
                    source: "osv",
                    cvssScore: cvss,
                    severityLevel: cvss >= 9 ? "critical" : "high",
                    aliases: [],
                }]))
                .returning();
            return row!;
        }

        /** An SBOM plus the successful scan run that makes it count as scanned. */
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

        it("measures resolved and introduced when both digests are scanned", async () => {
            const db = getTestDb();
            await post(report([workload([container(DIGEST_A)])]));

            // Scan both digests: A carries two findings, B keeps one and adds one.
            const [imageA] = await db.select().from(schema.images).where(eq(schema.images.digest, DIGEST_A));
            const [imageB] = await db
                .insert(schema.images)
                .values({ orgId: testData.org.id, clusterId, digest: DIGEST_B, repository: "acme/api" })
                .returning();
            const sbomA = await scanned(imageA!.id);
            const sbomB = await scanned(imageB!.id);
            const critical = await advisory("CVE-2026-0001", 9.8);
            const high = await advisory("CVE-2026-0002", 7.5);
            const other = await advisory("CVE-2026-0003", 7.0);
            await finding(sbomA.id, "openssl", critical.id);
            await finding(sbomA.id, "zlib", high.id);
            await finding(sbomB.id, "zlib", high.id);
            await finding(sbomB.id, "curl", other.id);

            await post(report([workload([container(DIGEST_B, { imageTag: "1.27" })])]));

            const evs = await events();
            const move = evs.find((e) => e.type === "container.image-changed")!;
            expect(move.payload).toMatchObject({
                deltaUnavailable: null,
                delta: expect.objectContaining({ resolved: 1, introduced: 1, unchanged: 1 }),
            });
            const delta = move.payload.delta as { riskBefore: number; riskAfter: number };
            expect(delta.riskBefore).toBeGreaterThan(delta.riskAfter);
        });

        it("says which side is unscanned instead of reporting zero", async () => {
            const db = getTestDb();
            await post(report([workload([container(DIGEST_A)])]));
            const [imageA] = await db.select().from(schema.images).where(eq(schema.images.digest, DIGEST_A));
            await scanned(imageA!.id);

            await post(report([workload([container(DIGEST_B)])]));

            const move = (await events()).find((e) => e.type === "container.image-changed")!;
            expect(move.payload).toMatchObject({ delta: null, deltaUnavailable: "to-unscanned" });
        });

        it("an SBOM whose scan failed does not count as scanned", async () => {
            const db = getTestDb();
            await post(report([workload([container(DIGEST_A)])]));
            const [imageA] = await db.select().from(schema.images).where(eq(schema.images.digest, DIGEST_A));
            const sbomA = await createSbom(db, { imageId: imageA!.id });
            await db.insert(schema.vulnerabilityScanRuns).values({
                orgId: testData.org.id,
                imageId: imageA!.id,
                sbomId: sbomA.id,
                trigger: "sbom_upload",
                status: "failed",
            });
            const [imageB] = await db
                .insert(schema.images)
                .values({ orgId: testData.org.id, clusterId, digest: DIGEST_B, repository: "acme/api" })
                .returning();
            const sbomB = await scanned(imageB!.id);
            await finding(sbomB.id, "openssl", (await advisory("CVE-2026-0001", 9.8)).id);

            await post(report([workload([container(DIGEST_B)])]));

            const move = (await events()).find((e) => e.type === "container.image-changed")!;
            expect(move.payload).toMatchObject({ delta: null, deltaUnavailable: "from-unscanned" });
        });

        it("is measured late, when the new digest's first scan lands after the move", async () => {
            const db = getTestDb();
            await post(report([workload([container(DIGEST_A)])]));
            const [imageA] = await db.select().from(schema.images).where(eq(schema.images.digest, DIGEST_A));
            const sbomA = await scanned(imageA!.id);
            const critical = await advisory("CVE-2026-0001", 9.8);
            await finding(sbomA.id, "openssl", critical.id);

            // The report lands first: the move is written unmeasured.
            await post(report([workload([container(DIGEST_B)])]));
            const [imageB] = await db.select().from(schema.images).where(eq(schema.images.digest, DIGEST_B));
            expect((await events()).find((e) => e.type === "container.image-changed")!.payload).toMatchObject({
                deltaUnavailable: "to-unscanned",
            });

            // Nothing to measure against until B has an SBOM.
            expect(await backfillMoveDeltas(imageB!.id)).toBe(0);

            // Then B is scanned and comes out clean.
            await scanned(imageB!.id);
            expect(await backfillMoveDeltas(imageB!.id)).toBe(1);

            const move = (await events()).find((e) => e.type === "container.image-changed")!;
            expect(move.payload).toMatchObject({
                deltaUnavailable: null,
                delta: expect.objectContaining({ resolved: 1, introduced: 0, unchanged: 0 }),
            });
            // The rest of the payload survived the update.
            expect(move.payload).toMatchObject({ workloadName: "web", containerName: "api" });

            // Idempotent: a second scan of B has nothing left to fill.
            expect(await backfillMoveDeltas(imageB!.id)).toBe(0);
        });
    });

    it("history survives the image GC nulling its image reference", async () => {
        await post(report([workload([container(DIGEST_A)])]));
        await post(report([workload([container(DIGEST_B)])]));

        const db = getTestDb();
        await db.delete(schema.images).where(eq(schema.images.digest, DIGEST_A));

        const rows = await intervals();
        const a = rows.find((r) => r.digest === DIGEST_A)!;
        expect(a.imageId).toBeNull();
        expect(a.endedAt).not.toBeNull();
    });
});
