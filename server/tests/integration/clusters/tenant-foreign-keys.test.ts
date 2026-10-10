import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createHelmRelease,
    createImage,
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

/**
 * The composite foreign keys that carry the tenant.
 *
 * `org_id` is denormalised down the containment chain, and each read path
 * filters on its own copy: `db/tenancy.ts` and `findDeployments` trust
 * `workload_containers.org_id`, the release surfaces trust
 * `helm_releases.org_id`, the namespace list trusts `namespaces.org_id`. Before
 * these constraints, nothing made those copies agree — a single row whose
 * `org_id` disagreed with its parent's was a cross-tenant leak on whichever
 * surface trusted the wrong one, and no test could have caught it because no
 * code path was wrong.
 *
 * These tests assert the constraint itself rather than any handler: the point
 * is that the bad row cannot be *written*, by any code path, including ones
 * that do not exist yet. See `src/db/schema/clusters.ts`.
 */

/**
 * The name of the constraint that rejected `fn`.
 *
 * Drizzle wraps driver errors in a "Failed query: …" message and hangs the
 * postgres-js error off `cause`, where `constraint_name` is. Asserting the name
 * rather than just "it threw" is the point: a `NOT NULL` or a unique-index
 * violation would also throw, and would not prove the tenant key did anything.
 */
async function rejectedBy(fn: () => Promise<unknown>): Promise<string> {
    try {
        await fn();
    } catch (err) {
        const cause = (err as { cause?: { constraint_name?: string } }).cause;
        return cause?.constraint_name ?? `no constraint_name on: ${String(err)}`;
    }
    throw new Error("expected the insert to be rejected, but it succeeded");
}

describe("tenant-carrying foreign keys", () => {
    let a: SeedTestScenarioResult;
    let b: SeedTestScenarioResult;

    beforeAll(() => { getTestDb(); });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        a = await seedTestScenario(db, {}, { name: "Org A", slug: "org-a-fk" });
        b = await seedTestScenario(db, {}, { name: "Org B", slug: "org-b-fk" });
    });

    it("rejects a namespace in one org pointing at another org's cluster", async () => {
        const db = getTestDb();
        expect(
            await rejectedBy(() =>
                db.insert(schema.namespaces).values({
                    orgId: a.org.id,
                    clusterId: b.cluster.id,
                    name: "default",
                })
            )
        ).toBe("namespaces_cluster_id_org_id_fk");
    });

    it("rejects a workload in one org pointing at another org's namespace", async () => {
        const db = getTestDb();
        const { namespace } = await seedRunningImage(db, b.org.id, b.cluster.id);

        expect(
            await rejectedBy(() =>
                db.insert(schema.workloads).values({
                    orgId: a.org.id,
                    namespaceId: namespace.id,
                    kind: "Deployment",
                    // Not "api" — `seedRunningImage` already put one of those in
                    // this namespace, and the natural-key unique index would
                    // reject the row before the tenant key was ever consulted.
                    name: "billing",
                })
            )
        ).toBe("workloads_namespace_id_org_id_fk");
    });

    /**
     * The one that matters most: `workload_containers.org_id` *is* the answer
     * to "may this org see this image".
     */
    it("rejects a container in one org pointing at another org's workload", async () => {
        const db = getTestDb();
        const { workload } = await seedRunningImage(db, b.org.id, b.cluster.id);
        const image = await createImage(db, a.org.id, a.cluster.id);

        expect(
            await rejectedBy(() =>
                db.insert(schema.workloadContainers).values({
                    orgId: a.org.id,
                    workloadId: workload.id,
                    name: "app",
                    imageId: image.id,
                    imageRef: `acme/app@${image.digest}`,
                })
            )
        ).toBe("workload_containers_workload_id_org_id_fk");
    });

    it("rejects a release in one org pointing at another org's cluster", async () => {
        const db = getTestDb();
        expect(
            await rejectedBy(() =>
                db.insert(schema.helmReleases).values({
                    orgId: a.org.id,
                    clusterId: b.cluster.id,
                    namespace: "default",
                    name: "web",
                })
            )
        ).toBe("helm_releases_cluster_id_org_id_fk");
    });

    it("rejects a workload claiming another org's release", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, b.org.id, b.cluster.id);
        const { namespace } = await seedRunningImage(db, a.org.id, a.cluster.id);

        expect(
            await rejectedBy(() =>
                db.insert(schema.workloads).values({
                    orgId: a.org.id,
                    namespaceId: namespace.id,
                    kind: "Deployment",
                    name: "web",
                    releaseId: release.id,
                })
            )
        ).toBe("workloads_release_id_org_id_fk");
    });

    /**
     * The scanner's ingest path reads *both* the org and the cluster off one
     * `api_keys` row and hands them to `replaceForCluster(orgId, clusterId, …)`.
     * A key bridging two orgs would write one tenant's entire inventory into
     * the other's.
     */
    it("rejects an API key scoped to another org's cluster", async () => {
        const db = getTestDb();
        expect(
            await rejectedBy(() =>
                db.insert(schema.apiKeys).values({
                    orgId: a.org.id,
                    clusterId: b.cluster.id,
                    createdBy: a.user.id,
                    name: "bridge",
                    keyPrefix: "sk_live_x",
                    keyHash: randomUUID(),
                })
            )
        ).toBe("api_keys_cluster_id_org_id_fk");
    });

    /**
     * `cluster_id` is nullable and MATCH SIMPLE skips a composite check
     * containing a null — which is what keeps org-scoped keys legal.
     */
    it("still allows an org-scoped API key with no cluster", async () => {
        const db = getTestDb();
        const [key] = await db.insert(schema.apiKeys).values({
            orgId: a.org.id,
            clusterId: null,
            createdBy: a.user.id,
            name: "org-scoped",
            keyPrefix: "sk_live_y",
            keyHash: randomUUID(),
        }).returning();

        expect(key).toBeDefined();
        expect(key!.clusterId).toBeNull();
    });

    it("accepts the whole chain when every org_id agrees", async () => {
        const db = getTestDb();
        const cluster = await createCluster(db, a.org.id, { name: "second" });
        const { container } = await seedRunningImage(db, a.org.id, cluster.id);

        expect(container.orgId).toBe(a.org.id);
    });

    /**
     * Deleting a cluster still takes its namespaces, workloads and containers
     * with it — and, since ADR 0006, its images and their SBOM subtrees. The
     * raw `DELETE FROM clusters` is deliberately no longer enough: the images
     * FK is NO ACTION precisely so deletion goes through the explicit sequence
     * in `clusterRepository.delete`.
     */
    it("refuses a raw cluster delete while its images exist", async () => {
        const db = getTestDb();
        await seedRunningImage(db, a.org.id, a.cluster.id);

        // Drizzle wraps the Postgres error; the violated constraint
        // (`images_cluster_id_org_id_fk`) rides on `cause`, so assert the
        // refusal and that the image survived it.
        await expect(
            db.delete(schema.clusters).where(eq(schema.clusters.id, a.cluster.id))
        ).rejects.toThrow();
        expect(
            await db.select().from(schema.clusters).where(eq(schema.clusters.id, a.cluster.id))
        ).toHaveLength(1);
    });

    it("cluster deletion removes the whole chain including images and SBOMs", async () => {
        const db = getTestDb();
        const { image, workload, container, namespace } =
            await seedRunningImage(db, a.org.id, a.cluster.id);
        const sbom = await createSbom(db, { imageId: image.id });

        // Imported lazily so the repository's `db` binds to the test database.
        const { clusterRepository } = await import(
            "../../../src/repositories/cluster.repository.js"
        );
        const deleted = await clusterRepository.delete(a.cluster.id, a.org.id);
        expect(deleted).toBe(true);

        for (const [table, id] of [
            [schema.namespaces, namespace.id],
            [schema.workloads, workload.id],
            [schema.workloadContainers, container.id],
            [schema.images, image.id],
            [schema.sboms, sbom.id],
        ] as const) {
            const rows = await db.select().from(table).where(eq(table.id, id));
            expect(rows).toHaveLength(0);
        }
    });
});
