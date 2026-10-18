/**
 * The Overview's first three pipeline stages: scanner, inventory, SBOMs.
 *
 * Each is "the freshest fact the stage has written", and each has a null
 * that must survive: no cluster has reported, no container has been seen,
 * no SBOM has landed. Those nulls are what a fresh install shows, and the
 * tile reads them as "not yet" rather than as a failure — so a zero or an
 * epoch date in their place would be wrong twice over.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads
 * DATABASE_URL at module load and test-setup.ts only sets it in its own
 * beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrganization,
    createOrgWithOwner,
    createCluster,
    createImage,
    createSbom,
    seedRunningImage,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let adminStatusRepository: typeof import("../../../src/repositories/admin-status.repository.js").adminStatusRepository;

beforeAll(async () => {
    adminStatusRepository = (await import("../../../src/repositories/admin-status.repository.js"))
        .adminStatusRepository;
});

beforeEach(async () => {
    await cleanAllData();
});

describe("getPipelineHealth", () => {
    it("is all nulls on an empty database — nothing has happened yet, nothing is wrong", async () => {
        const health = await adminStatusRepository.getPipelineHealth();
        expect(health.scanner.clusters).toEqual([]);
        expect(health.scanner.total).toBe(0);
        expect(health.inventory.newestSeenAt).toBeNull();
        expect(health.sboms.newestCreatedAt).toBeNull();
    });

    it("ships each tenant cluster's scanner facts and leaves the platform cluster out", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const prod = await createCluster(db, org.id, { name: "prod" });
        const seen = new Date(Date.now() - 90_000);
        await db
            .update(schema.clusters)
            .set({
                scannerVersion: "0.4.2",
                scannerLastSeenAt: seen,
                kubernetesVersion: "v1.31.2",
                ownerMetadataCollected: false,
            })
            .where(eq(schema.clusters.id, prod.id));

        const platform = await createOrganization(db, { slug: "stackradar-platform", system: true });
        await createCluster(db, platform.id, { name: "platform-scanner" });

        const { scanner } = await adminStatusRepository.getPipelineHealth();

        expect(scanner.total).toBe(1);
        expect(scanner.clusters).toHaveLength(1);
        expect(scanner.clusters[0]).toMatchObject({
            id: prod.id,
            name: "prod",
            scannerVersion: "0.4.2",
            kubernetesVersion: "v1.31.2",
            // The agent said it could not read controllers: false, never null.
            ownerMetadataCollected: false,
        });
        expect(scanner.clusters[0]?.scannerLastSeenAt?.getTime()).toBe(seen.getTime());
    });

    it("reports the newest container sighting and the newest SBOM", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db);
        const cluster = await createCluster(db, org.id);
        const { image } = await seedRunningImage(db, org.id, cluster.id, { workloadName: "web" });
        const sbom = await createSbom(db, { imageId: image.id });
        const other = await createImage(db, org.id, cluster.id, { repository: "acme/other" });
        await createSbom(db, { imageId: other.id });

        const health = await adminStatusRepository.getPipelineHealth();

        const [newestContainer] = await db
            .select({ at: schema.workloadContainers.lastSeenAt })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.imageId, image.id));
        expect(health.inventory.newestSeenAt?.getTime()).toBe(newestContainer?.at.getTime());
        expect(health.sboms.newestCreatedAt?.getTime()).toBeGreaterThanOrEqual(sbom.createdAt.getTime());
    });
});
