/**
 * The Admin dashboard's view of the `images` table.
 *
 * Every other image surface on the platform starts `FROM sboms` and filters by
 * `deployedImages(orgId)`, so it can only ever show an image that has been
 * scanned *and* runs in the org being asked about. Two populations fall through
 * that gap and both are operational problems:
 *
 * - an image discovered by an inventory report that nothing has scanned yet —
 *   the ingest backlog;
 * - an image no `workload_containers` row references at all — what the nightly
 *   GC is aiming at, and the only thing on the platform that deletes SBOMs.
 *
 * The tests below are written against those two populations rather than against
 * the happy path, because the happy path is the one case the Explorer already
 * covered. The state predicates are shared with `getSystemStats`, so a drift
 * between the tab's filter and the Overview's counts would show up here too.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createImage,
    createSbom,
    seedRunningImage,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import type { Cluster } from "../../../src/db/schema/index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

let adminRepository: typeof import("../../../src/repositories/admin.repository.js").adminRepository;
let adminStatusRepository: typeof import("../../../src/repositories/admin-status.repository.js").adminStatusRepository;

let testData: CreateOrgWithOwnerResult;
let cluster: Cluster;

beforeAll(async () => {
    adminRepository = (await import("../../../src/repositories/admin.repository.js")).adminRepository;
    adminStatusRepository = (await import("../../../src/repositories/admin-status.repository.js"))
        .adminStatusRepository;
});

beforeEach(async () => {
    await cleanAllData();
    const db = getTestDb();
    testData = await createOrgWithOwner(db);
    cluster = await createCluster(db, testData.org.id, { name: "prod" });
});

const page = (options: Partial<Parameters<typeof adminRepository.listAdminImages>[0]> = {}) =>
    adminRepository.listAdminImages({ limit: 50, offset: 0, ...options });

import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("listAdminImages", () => {
    it("lists an image nothing references — the row every other surface hides", async () => {
        const db = getTestDb();
        // No workload_containers, no SBOM. Invisible to the Explorer, to the
        // customer-facing image list, and to every finding count.
        const orphan = await createImage(db, testData.org.id, cluster.id, { repository: "acme/abandoned" });

        const result = await page();

        expect(result.total).toBe(1);
        expect(result.images[0]?.id).toBe(orphan.id);
        expect(result.images[0]?.state).toBe("orphaned");
        expect(result.images[0]?.containerCount).toBe(0);
    });

    it("distinguishes an unscanned running image from a scanned one", async () => {
        const db = getTestDb();
        const { image: unscanned } = await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/new" }),
            workloadName: "new",
        });
        const { image: scanned } = await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/old" }),
            workloadName: "old",
        });
        await createSbom(db, { imageId: scanned.id });

        const byId = new Map((await page()).images.map((i) => [i.id, i]));

        expect(byId.get(unscanned.id)?.state).toBe("awaiting_sbom");
        expect(byId.get(unscanned.id)?.sbomId).toBeNull();
        expect(byId.get(scanned.id)?.state).toBe("scanned");
        expect(byId.get(scanned.id)?.sbomId).not.toBeNull();
    });

    it("calls an image orphaned even when it carries an SBOM", async () => {
        const db = getTestDb();
        // A cluster-free upload, or the remains of a deleted cluster. Having an
        // SBOM must not stop it reading as a GC candidate — that is the fact
        // with a deadline attached, and the one an admin has to act on.
        const image = await createImage(db, testData.org.id, cluster.id, { repository: "acme/uploaded" });
        await createSbom(db, { imageId: image.id });

        const result = await page();

        expect(result.images[0]?.state).toBe("orphaned");
        expect(result.images[0]?.sbomId).not.toBeNull();
    });

    it("reports findings as null until something has scanned the image", async () => {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/pending" }),
        });
        await createSbom(db, { imageId: image.id });

        // An SBOM has landed but no matcher run and no match rows exist, so the
        // honest answer is "nobody has looked" — a zeroed severity block here
        // would render as a clean image on the dashboard.
        expect((await page()).images[0]?.findings).toBeNull();
    });

    it("keeps a digest shared across tenants as one row per cluster", async () => {
        const db = getTestDb();
        const other = await createOrgWithOwner(db, { email: `second-${Date.now()}@example.com` });
        const otherCluster = await createCluster(db, other.org.id, { name: "other-prod" });

        // One digest, two tenants — two rows now that images are cluster-scoped,
        // so neither org's usage is visible on the other's row.
        const digest = `sha256:${"ab".repeat(32)}`;
        const ours = await createImage(db, testData.org.id, cluster.id, { repository: "library/nginx", digest });
        const theirs = await createImage(db, other.org.id, otherCluster.id, { repository: "library/nginx", digest });
        await seedRunningImage(db, testData.org.id, cluster.id, { image: ours, workloadName: "web" });
        await seedRunningImage(db, testData.org.id, cluster.id, { image: ours, workloadName: "api" });
        await seedRunningImage(db, other.org.id, otherCluster.id, { image: theirs, workloadName: "web" });

        const byId = new Map((await page()).images.map((i) => [i.id, i]));

        expect(byId.size).toBe(2);
        expect(byId.get(ours.id)?.containerCount).toBe(2);
        expect(byId.get(ours.id)?.clusterCount).toBe(1);
        expect(byId.get(theirs.id)?.containerCount).toBe(1);
    });

    itCloud("counts the GC countdown down from last_seen_at, and only for orphans", async () => {
        const db = getTestDb();
        const fresh = await createImage(db, testData.org.id, cluster.id, {
            repository: "acme/fresh",
            lastSeenAt: daysAgo(2),
        });
        const stale = await createImage(db, testData.org.id, cluster.id, {
            repository: "acme/stale",
            lastSeenAt: daysAgo(45),
        });
        const { image: running } = await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, {
                repository: "acme/running",
                lastSeenAt: daysAgo(90),
            }),
        });

        const byId = new Map((await page()).images.map((i) => [i.id, i]));

        // Default retention is 30 days, and the countdown rounds up: an image
        // 2 days old has 28 days to go, one 45 days old is already past.
        expect(byId.get(fresh.id)?.gcInDays).toBe(28);
        expect(byId.get(stale.id)?.gcInDays).toBeLessThanOrEqual(0);
        // Referenced, so the countdown does not apply however old last_seen_at is.
        expect(byId.get(running.id)?.gcInDays).toBeNull();
    });

    it("filters by state, and leaves the state totals unfiltered", async () => {
        const db = getTestDb();
        await createImage(db, testData.org.id, cluster.id, { repository: "acme/orphan-a" });
        await createImage(db, testData.org.id, cluster.id, { repository: "acme/orphan-b" });
        await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/running" }),
        });

        const result = await page({ state: "orphaned" });

        expect(result.total).toBe(2);
        expect(result.images.every((i) => i.state === "orphaned")).toBe(true);
        // The totals label the filter control itself, so applying a filter must
        // not move them — otherwise the counts change as you click through them.
        expect(result.stateTotals).toEqual({ orphaned: 2, awaiting_sbom: 1, scanned: 0 });
    });

    it("searches digest, repository and registry", async () => {
        const db = getTestDb();
        await createImage(db, testData.org.id, cluster.id, { registry: "ghcr.io", repository: "acme/payments" });
        await createImage(db, testData.org.id, cluster.id, { registry: "docker.io", repository: "library/redis" });

        expect((await page({ search: "payments" })).total).toBe(1);
        expect((await page({ search: "docker.io" })).total).toBe(1);
        expect((await page({ search: "nothing-here" })).total).toBe(0);
    });

    it("pages without repeating or skipping rows", async () => {
        const db = getTestDb();
        for (let i = 0; i < 5; i++) {
            await createImage(db, testData.org.id, cluster.id, { repository: `acme/app-${i}` });
        }

        const first = await page({ limit: 2, offset: 0, sort: "repository" });
        const second = await page({ limit: 2, offset: 2, sort: "repository" });

        expect(first.total).toBe(5);
        expect(first.images).toHaveLength(2);
        expect(second.images).toHaveLength(2);
        const ids = new Set([...first.images, ...second.images].map((i) => i.id));
        expect(ids.size).toBe(4);
    });
});

describe("getSystemStats — images and Kubernetes inventory", () => {
    it("counts the whole images table, not just the scanned or deployed part", async () => {
        const db = getTestDb();
        const { image: scanned } = await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/scanned" }),
            workloadName: "scanned",
        });
        await createSbom(db, { imageId: scanned.id });
        await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/awaiting" }),
            workloadName: "awaiting",
        });
        await createImage(db, testData.org.id, cluster.id, { repository: "acme/orphan" });

        const stats = await adminStatusRepository.getSystemStats();

        expect(stats.images.total).toBe(3);
        expect(stats.images.withSbom).toBe(1);
        expect(stats.images.orphaned).toBe(1);
        // Not `total - withSbom` (which would be 2): the orphan nobody runs is
        // the GC's problem, not the scanner's, and lumping the two together
        // makes the backlog look permanently worse than it is.
        expect(stats.images.awaitingSbom).toBe(1);
    });

    it("counts every Kubernetes table across tenants", async () => {
        const db = getTestDb();
        await seedRunningImage(db, testData.org.id, cluster.id, { workloadName: "web", namespace: "default" });
        await seedRunningImage(db, testData.org.id, cluster.id, { workloadName: "api", namespace: "backend" });

        const stats = await adminStatusRepository.getSystemStats();

        expect(stats.kubernetes.clusters).toBe(1);
        expect(stats.kubernetes.namespaces).toBe(2);
        expect(stats.kubernetes.workloads).toBe(2);
        expect(stats.kubernetes.containers).toBe(2);
    });

    it("agrees with the tab's own state totals", async () => {
        const db = getTestDb();
        await createImage(db, testData.org.id, cluster.id, { repository: "acme/orphan" });
        await seedRunningImage(db, testData.org.id, cluster.id, {
            image: await createImage(db, testData.org.id, cluster.id, { repository: "acme/awaiting" }),
        });

        const [stats, listing] = await Promise.all([adminStatusRepository.getSystemStats(), page()]);

        // Both read the same predicates. If this ever fails, the Overview and
        // the Images tab have started answering the same question differently.
        expect(stats.images.orphaned).toBe(listing.stateTotals.orphaned);
        expect(stats.images.awaitingSbom).toBe(listing.stateTotals.awaiting_sbom);
        expect(stats.images.total).toBe(listing.total);
    });
});
