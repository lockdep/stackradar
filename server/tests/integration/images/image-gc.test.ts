import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createImage,
    createSbom,
    seedRunningImage,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { Cluster } from "../../../src/db/schema/index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * The sweep that reclaims images nothing refers to any more. Cluster deletion
 * removes its own images explicitly (ADR 0006); the sweep covers what that
 * cannot see — rows aged past the org's archive window with no container
 * holding them. The window is the *plan's* `historyDays` floored by
 * `IMAGE_GC_RETENTION_DAYS` (30 days for the default free-plan orgs these
 * tests seed). These tests pin both halves — what must be collected, and what
 * must survive a sweep.
 */
import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("deleteOrphanedImages", () => {
    let testData: CreateOrgWithOwnerResult;
    let cluster: Cluster;
    let deleteOrphanedImages: (typeof import("../../../src/repositories/delete-helpers.js"))["deleteOrphanedImages"];

    const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

    beforeAll(async () => {
        const mod = await import("../../../src/repositories/delete-helpers.js");
        deleteOrphanedImages = mod.deleteOrphanedImages;
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        // No plan: the 30-day floor the GC is asserted against.
        testData = await createOrgWithOwner(db, {}, { plan: "free" });
        cluster = await createCluster(db, testData.org.id, { name: "prod" });
    });

    async function imageExists(id: string): Promise<boolean> {
        const rows = await getTestDb()
            .select({ id: schema.images.id })
            .from(schema.images)
            .where(eq(schema.images.id, id));
        return rows.length > 0;
    }

    async function addComponent(sbomId: string, name: string): Promise<string> {
        const [component] = await getTestDb()
            .insert(schema.components)
            .values({ sbomId, name, type: "library", version: "1.0.0" })
            .returning();
        return component!.id;
    }

    itCloud("collects an unreferenced image older than the cutoff, with its SBOM and components", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        const sbom = await createSbom(db, { imageId: image.id });
        const componentId = await addComponent(sbom.id, "openssl");

        const collected = await deleteOrphanedImages(100);

        expect(collected).toBe(1);
        expect(await imageExists(image.id)).toBe(false);

        const sboms = await db.select({ id: schema.sboms.id }).from(schema.sboms).where(eq(schema.sboms.id, sbom.id));
        expect(sboms).toHaveLength(0);

        const components = await db
            .select({ id: schema.components.id })
            .from(schema.components)
            .where(eq(schema.components.id, componentId));
        expect(components).toHaveLength(0);
    });

    it("keeps an image a workload container still references, however old", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(400) });
        await seedRunningImage(db, testData.org.id, cluster.id, { image });

        const collected = await deleteOrphanedImages(100);

        expect(collected).toBe(0);
        expect(await imageExists(image.id)).toBe(true);
    });

    it("keeps a recently seen image with no containers — a rollout, not garbage", async () => {
        const db = getTestDb();
        // Zero containers is what the seconds between two inventory reports look
        // like. Reachability alone would collect this and cost a re-pull.
        const image = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(1) });
        await createSbom(db, { imageId: image.id });

        const collected = await deleteOrphanedImages(100);

        expect(collected).toBe(0);
        expect(await imageExists(image.id)).toBe(true);
    });

    it("keeps another org's image its own containers still reference", async () => {
        const db = getTestDb();
        const other = await createOrgWithOwner(db);
        const otherCluster = await createCluster(db, other.org.id, { name: "their-prod" });

        // Cluster-scoped images: the other tenant owns its own row for the
        // digest, and its container is what holds that row against the sweep.
        const theirs = await createImage(db, other.org.id, otherCluster.id, { lastSeenAt: daysAgo(60) });
        await seedRunningImage(db, other.org.id, otherCluster.id, { image: theirs });

        const collected = await deleteOrphanedImages(100);

        expect(collected).toBe(0);
        expect(await imageExists(theirs.id)).toBe(true);
    });

    it("leaves a live cluster's images alone; deletion takes them with the cluster", async () => {
        const db = getTestDb();
        const clusterRepo = (await import("../../../src/repositories/cluster.repository.js")).clusterRepository;

        const image = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        await createSbom(db, { imageId: image.id });
        await seedRunningImage(db, testData.org.id, cluster.id, { image });

        // While the cluster stands, the container holds the image.
        expect(await deleteOrphanedImages(100)).toBe(0);

        await clusterRepo.delete(cluster.id, testData.org.id);

        // Cluster deletion removes its images itself now (ADR 0006), so the
        // sweep finds nothing left to collect.
        expect(await imageExists(image.id)).toBe(false);
        expect(await deleteOrphanedImages(100)).toBe(0);
    });

    itCloud("collects at most `limit` images per run, oldest first", async () => {
        const db = getTestDb();
        const oldest = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(90) });
        const middle = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        const newest = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(45) });

        const collected = await deleteOrphanedImages(2);

        expect(collected).toBe(2);
        expect(await imageExists(oldest.id)).toBe(false);
        expect(await imageExists(middle.id)).toBe(false);
        expect(await imageExists(newest.id)).toBe(true);
    });

    itCloud("leaves the shared licenses catalog alone", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        const sbom = await createSbom(db, { imageId: image.id });
        const componentId = await addComponent(sbom.id, "openssl");

        const [license] = await db.insert(schema.licenses).values({ spdxId: "MIT", name: "MIT License" }).returning();
        await db.insert(schema.componentLicenses).values({ componentId, licenseId: license!.id });

        await deleteOrphanedImages(100);

        // The join row goes with the component; the catalog entry is global and
        // is shared with every other SBOM that references MIT.
        const links = await db
            .select({ componentId: schema.componentLicenses.componentId })
            .from(schema.componentLicenses)
            .where(eq(schema.componentLicenses.componentId, componentId));
        expect(links).toHaveLength(0);

        const catalog = await db
            .select({ id: schema.licenses.id })
            .from(schema.licenses)
            .where(eq(schema.licenses.id, license!.id));
        expect(catalog).toHaveLength(1);
    });

    it("leaves a second orphan's neighbours untouched when one is collected", async () => {
        const db = getTestDb();
        const doomed = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        const doomedSbom = await createSbom(db, { imageId: doomed.id });
        await addComponent(doomedSbom.id, "openssl");

        const kept = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(1) });
        const keptSbom = await createSbom(db, { imageId: kept.id });
        const keptComponent = await addComponent(keptSbom.id, "zlib");

        await deleteOrphanedImages(100);

        const survivors = await db
            .select({ id: schema.components.id })
            .from(schema.components)
            .where(eq(schema.components.id, keptComponent));
        expect(survivors).toHaveLength(1);
    });

    it("is a no-op when nothing is old enough", async () => {
        const db = getTestDb();
        await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(2) });

        expect(await deleteOrphanedImages(100)).toBe(0);
    });

    itCloud("keeps a paid org's orphan for the plan's history window, not the free floor", async () => {
        const db = getTestDb();
        const paid = await createOrgWithOwner(db, {}, { plan: "pro" }); // 365-day window
        const paidCluster = await createCluster(db, paid.org.id, { name: "paid-prod" });

        // Same age, two verdicts: 60 days is past the free window but well
        // inside Pro's — the SBOM archive is part of what the plan buys.
        const freeOrphan = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        const paidOrphan = await createImage(db, paid.org.id, paidCluster.id, { lastSeenAt: daysAgo(60) });
        const paidExpired = await createImage(db, paid.org.id, paidCluster.id, { lastSeenAt: daysAgo(400) });

        const collected = await deleteOrphanedImages(100);

        expect(collected).toBe(2);
        expect(await imageExists(freeOrphan.id)).toBe(false);
        expect(await imageExists(paidOrphan.id)).toBe(true);
        expect(await imageExists(paidExpired.id)).toBe(false);
    });

    itCloud("collects the jobs and scan runs that pointed at the image", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id, { lastSeenAt: daysAgo(60) });
        const sbom = await createSbom(db, { imageId: image.id });

        await db.insert(schema.jobs).values({
            orgId: testData.org.id,
            imageId: image.id,
            sbomId: sbom.id,
            type: "vulnerability_scan",
            status: "completed",
            title: "Scan orphan",
        });
        await db.insert(schema.vulnerabilityScanRuns).values({
            orgId: testData.org.id,
            imageId: image.id,
            sbomId: sbom.id,
            trigger: "manual",
            status: "success",
        });

        await deleteOrphanedImages(100);

        const jobs = await db
            .select({ id: schema.jobs.id })
            .from(schema.jobs)
            .where(and(eq(schema.jobs.orgId, testData.org.id)));
        expect(jobs).toHaveLength(0);

        const runs = await db
            .select({ id: schema.vulnerabilityScanRuns.id })
            .from(schema.vulnerabilityScanRuns)
            .where(eq(schema.vulnerabilityScanRuns.orgId, testData.org.id));
        expect(runs).toHaveLength(0);
    });
});
