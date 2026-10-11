import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createImage,
    createSbom,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { Cluster } from "../../../src/db/schema/index.js";
import type { SyncCycleResult } from "../../../src/osv-sync/types.js";

function syncResult(overrides: Partial<SyncCycleResult> = {}): SyncCycleResult {
    return {
        success: true,
        mode: "incremental",
        syncRunId: randomUUID(),
        recordsProcessed: 5,
        inserted: 3,
        updated: 2,
        unchanged: 0,
        affectedPackagesExtracted: 5,
        schemaValidationWarnings: 0,
        parseFailures: 0,
        deduplicatedCandidates: 0,
        deduplications: [],
        errors: [],
        durationMs: 1000,
        lagSeconds: 60,
        ...overrides,
    };
}

/**
 * The bridge from "the mirror changed" to "the fleet's findings refresh":
 * every image with an SBOM gets a scheduled_scan queued, unless one is
 * already waiting or running. Without this, an image is matched exactly once
 * — at upload — and a CVE published afterwards never surfaces.
 */
describe("enqueueRescansAfterMirrorChange", () => {
    let testData: CreateOrgWithOwnerResult;
    let cluster: Cluster;
    let enqueueRescansAfterMirrorChange: (typeof import("../../../src/osv-sync/rescan.js"))["enqueueRescansAfterMirrorChange"];
    let mirrorChanged: (typeof import("../../../src/osv-sync/rescan.js"))["mirrorChanged"];

    beforeAll(async () => {
        const mod = await import("../../../src/osv-sync/rescan.js");
        enqueueRescansAfterMirrorChange = mod.enqueueRescansAfterMirrorChange;
        mirrorChanged = mod.mirrorChanged;
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await createOrgWithOwner(db);
        cluster = await createCluster(db, testData.org.id, { name: "prod" });
    });

    async function jobsForImage(imageId: string) {
        return getTestDb().select().from(schema.jobs).where(eq(schema.jobs.imageId, imageId));
    }

    it("should queue a scheduled_scan for every image with an SBOM, and none for images without one", async () => {
        const db = getTestDb();
        const scanned = await createImage(db, testData.org.id, cluster.id, {
            repository: "library/nginx",
        });
        const sbom = await createSbom(db, { imageId: scanned.id });
        const unscanned = await createImage(db, testData.org.id, cluster.id);

        const enqueued = await enqueueRescansAfterMirrorChange(syncResult());

        expect(enqueued).toBe(1);
        const [job] = await jobsForImage(scanned.id);
        expect(job).toMatchObject({
            orgId: testData.org.id,
            sbomId: sbom.id,
            type: "scheduled_scan",
            status: "pending",
            priority: 1,
            triggeredBy: "schedule",
        });
        expect(job!.title).toBe(`library/nginx@${scanned.digest.slice(0, 19)}: Scheduled Security Scan`);
        expect(await jobsForImage(unscanned.id)).toHaveLength(0);
    });

    it("should not stack a rescan behind an image's pending, scheduled or running scan", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id);
        await createSbom(db, { imageId: image.id });
        await db.insert(schema.jobs).values({
            orgId: testData.org.id,
            imageId: image.id,
            type: "vulnerability_scan",
            status: "pending",
            title: "existing scan",
        });

        const enqueued = await enqueueRescansAfterMirrorChange(syncResult());

        expect(enqueued).toBe(0);
        expect(await jobsForImage(image.id)).toHaveLength(1);
    });

    it("should queue again once the previous scan is in a terminal state", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id);
        await createSbom(db, { imageId: image.id });
        await db.insert(schema.jobs).values({
            orgId: testData.org.id,
            imageId: image.id,
            type: "vulnerability_scan",
            status: "completed",
            title: "finished scan",
        });

        const enqueued = await enqueueRescansAfterMirrorChange(syncResult());

        expect(enqueued).toBe(1);
        expect(await jobsForImage(image.id)).toHaveLength(2);
    });

    it("should do nothing when the cycle applied no records", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, cluster.id);
        await createSbom(db, { imageId: image.id });

        const enqueued = await enqueueRescansAfterMirrorChange(syncResult({ inserted: 0, updated: 0, unchanged: 12 }));

        expect(enqueued).toBe(0);
        expect(await jobsForImage(image.id)).toHaveLength(0);
    });

    describe("mirrorChanged", () => {
        it("should be false for failed, skipped and noop cycles regardless of counts", () => {
            expect(mirrorChanged(syncResult({ success: false }))).toBe(false);
            expect(mirrorChanged(syncResult({ skipped: true }))).toBe(false);
            expect(mirrorChanged(syncResult({ noop: true }))).toBe(false);
        });

        it("should be true for any completed bootstrap — a whole generation swapped in", () => {
            expect(mirrorChanged(syncResult({ mode: "initialization", inserted: 0, updated: 0 }))).toBe(true);
        });

        it("should require applied records for an incremental cycle", () => {
            expect(mirrorChanged(syncResult({ inserted: 0, updated: 0 }))).toBe(false);
            expect(mirrorChanged(syncResult({ inserted: 1, updated: 0 }))).toBe(true);
            expect(mirrorChanged(syncResult({ inserted: 0, updated: 1 }))).toBe(true);
        });
    });
});
