import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, createCluster, seedRunningImage } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

type MetricsService = typeof import("../../../src/services/metrics.service.js").metricsService;

/**
 * The post-scan snapshot write: a brand-new org gets its first trend point when
 * its first scan finishes rather than at the next `0 * * * *` boundary, and
 * that point keeps up with the rest of the install instead of freezing at
 * whichever workload happened to finish first.
 */
describe("metricsService.refreshSnapshots", () => {
    let metricsService: MetricsService;

    beforeAll(async () => {
        // Dynamic import so DATABASE_URL is set by the setup file first.
        ({ metricsService } = await import("../../../src/services/metrics.service.js"));
    });

    beforeEach(async () => {
        await cleanAllData();
    });

    async function orgSnapshots(orgId: string) {
        return getTestDb().select().from(schema.orgMetricsSnapshots).where(eq(schema.orgMetricsSnapshots.orgId, orgId));
    }

    async function clusterSnapshots(clusterId: string) {
        return getTestDb()
            .select()
            .from(schema.clusterMetricsSnapshots)
            .where(eq(schema.clusterMetricsSnapshots.clusterId, clusterId));
    }

    it("captures an org and a cluster snapshot for a first workload", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const cluster = await createCluster(db, org.id);
        await seedRunningImage(db, org.id, cluster.id);

        await metricsService.refreshSnapshots(org.id, cluster.id);

        const orgRows = await orgSnapshots(org.id);
        const clusterRows = await clusterSnapshots(cluster.id);
        expect(orgRows).toHaveLength(1);
        expect(orgRows[0]!.totalWorkloads).toBe(1);
        expect(clusterRows).toHaveLength(1);
        expect(clusterRows[0]!.totalWorkloads).toBe(1);
    });

    it("follows the numbers up as the rest of the install lands", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const cluster = await createCluster(db, org.id);

        // First scan finishes: one workload known, the rest still arriving.
        await seedRunningImage(db, org.id, cluster.id, { workloadName: "api" });
        await metricsService.refreshSnapshots(org.id, cluster.id);
        expect((await orgSnapshots(org.id))[0]!.totalWorkloads).toBe(1);

        // Each later scan rewrites the same row rather than adding one, so the
        // chart keeps a single point and it ends up correct on its own.
        await seedRunningImage(db, org.id, cluster.id, { workloadName: "web" });
        await metricsService.refreshSnapshots(org.id, cluster.id);
        await seedRunningImage(db, org.id, cluster.id, { workloadName: "worker" });
        await metricsService.refreshSnapshots(org.id, cluster.id);

        const orgRows = await orgSnapshots(org.id);
        expect(orgRows).toHaveLength(1);
        expect(orgRows[0]!.totalWorkloads).toBe(3);

        const clusterRows = await clusterSnapshots(cluster.id);
        expect(clusterRows).toHaveLength(1);
        expect(clusterRows[0]!.totalWorkloads).toBe(3);
    });

    it("rewrites an all-zero cron row rather than leaving it on the chart", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const cluster = await createCluster(db, org.id);

        // What the cron captures for an org that signed up before it installed.
        await db.insert(schema.orgMetricsSnapshots).values({
            orgId: org.id,
            totalVulnerabilities: 0,
            totalWorkloads: 0,
            totalComponents: 0,
        });

        await seedRunningImage(db, org.id, cluster.id);
        await metricsService.refreshSnapshots(org.id, cluster.id);

        const orgRows = await orgSnapshots(org.id);
        expect(orgRows).toHaveLength(1);
        expect(orgRows[0]!.totalWorkloads).toBe(1);
    });

    it("adds a point beside a row from an earlier period instead of rewriting it", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const cluster = await createCluster(db, org.id);
        await seedRunningImage(db, org.id, cluster.id);

        /* Outside the current period the newest row is real history: a scan
           landing now is a new point, not a correction to that one. */
        const old = new Date(Date.now() - 3 * 60 * 60_000);
        await db.insert(schema.orgMetricsSnapshots).values({
            orgId: org.id,
            capturedAt: old,
            totalVulnerabilities: 0,
            totalWorkloads: 9,
            totalComponents: 0,
        });

        await metricsService.refreshSnapshots(org.id, cluster.id);

        const rows = (await orgSnapshots(org.id)).sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
        expect(rows).toHaveLength(2);
        expect(rows[0]!.totalWorkloads).toBe(9);
        expect(rows[0]!.capturedAt.getTime()).toBe(old.getTime());
        expect(rows[1]!.totalWorkloads).toBe(1);
    });

    it("gives a new cluster its own point without disturbing the org's", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const first = await createCluster(db, org.id, { name: "prod" });
        await seedRunningImage(db, org.id, first.id, { workloadName: "api" });
        await metricsService.refreshSnapshots(org.id, first.id);

        const second = await createCluster(db, org.id, { name: "staging" });
        await seedRunningImage(db, org.id, second.id, { workloadName: "web" });
        await metricsService.refreshSnapshots(org.id, second.id);

        // One org point, still rewritten in place and now covering both clusters.
        const orgRows = await orgSnapshots(org.id);
        expect(orgRows).toHaveLength(1);
        expect(orgRows[0]!.totalWorkloads).toBe(2);

        expect(await clusterSnapshots(first.id)).toHaveLength(1);
        const secondRows = await clusterSnapshots(second.id);
        expect(secondRows).toHaveLength(1);
        expect(secondRows[0]!.totalWorkloads).toBe(1);
    });

    it("records a zero row when the org has nothing to snapshot yet", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const cluster = await createCluster(db, org.id);

        await metricsService.refreshSnapshots(org.id, cluster.id);

        // The honest state at that instant, and the next call corrects it.
        expect((await orgSnapshots(org.id))[0]!.totalWorkloads).toBe(0);
        await seedRunningImage(db, org.id, cluster.id);
        await metricsService.refreshSnapshots(org.id, cluster.id);
        expect((await orgSnapshots(org.id))[0]!.totalWorkloads).toBe(1);
    });
});
