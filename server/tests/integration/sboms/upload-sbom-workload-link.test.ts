import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createApiKeyHeaders, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    createApiKey,
    createCluster,
    createClusterApiKey,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const MINIMAL_SBOM = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    components: [],
};

let digestCounter = 1000;
function nextDigest(): string {
    digestCounter += 1;
    return `sha256:${String(digestCounter).padStart(64, "0")}`;
}

/**
 * The upload path's two identities.
 *
 * Image identity says *what this cluster scanned* and is required — the
 * cluster half comes from the API key, which every upload must carry
 * (ADR 0006). Workload identity says *where it runs*, is optional, and is
 * what replaced the `projectName`/`groupName` pair — two Kubernetes concepts
 * that used to be crammed into one `"<workload>/<container>"` varchar plus a
 * group name.
 */
describe("POST /v1/sboms/upload/cyclonedx — image and workload identity", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
    });

    it("creates the image row from the digest alone", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}&imageRef=${encodeURIComponent("ghcr.io/acme/nginx:1.25")}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [image] = await db
            .select()
            .from(schema.images)
            .where(eq(schema.images.digest, digest));

        expect(image).toBeDefined();
        // registry/repository parsed out of the ref when not sent explicitly.
        expect(image!.registry).toBe("ghcr.io");
        expect(image!.repository).toBe("acme/nginx");
        // The image belongs to the cluster on the key (ADR 0006).
        expect(image!.orgId).toBe(testData.org.id);
        expect(image!.clusterId).toBe(testData.cluster.id);
    });

    it("creates the namespace, workload and container when workload identity is supplied", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
                `&namespace=production&workloadName=nginx&workloadKind=Deployment&containerName=web&tag=1.25`,
            )
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [namespace] = await db
            .select()
            .from(schema.namespaces)
            .where(and(
                eq(schema.namespaces.clusterId, testData.cluster.id),
                eq(schema.namespaces.name, "production"),
            ));
        expect(namespace).toBeDefined();

        const [workload] = await db
            .select()
            .from(schema.workloads)
            .where(eq(schema.workloads.namespaceId, namespace!.id));
        expect(workload).toMatchObject({ name: "nginx", kind: "Deployment" });

        const [container] = await db
            .select()
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.workloadId, workload!.id));
        // The tag lives on the container. A digest may carry many tags, and a
        // digest-pinned deployment has none — it is a deployment fact.
        expect(container).toMatchObject({ name: "web", imageTag: "1.25" });
    });

    it("stores no tag for a digest-pinned deployment rather than inventing 'latest'", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
                `&namespace=production&workloadName=nginx&containerName=web`,
            )
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [container] = await db.select().from(schema.workloadContainers);
        expect(container!.imageTag).toBeNull();
    });

    it("leaves kind null when the scanner could not resolve the owner chain", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
                `&namespace=production&workloadName=orphan-pod&containerName=app`,
            )
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const [workload] = await db.select().from(schema.workloads);
        // Not "Pod". A guessed kind produces a wrong remediation command.
        expect(workload!.kind).toBeNull();
    });

    /**
     * Cluster-free ingest is retired (ADR 0006): image identity is
     * `(clusterId, digest)`, so an upload with no cluster behind its key has
     * nowhere to hang — and an org-scoped credential must not be able to
     * plant an SBOM at all.
     */
    it("rejects an image-only upload from an org-scoped key with 403", async () => {
        const db = getTestDb();
        const digest = nextDigest();
        const orgKey = await createApiKey(db, testData.org.id, testData.user.id);

        const response = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(orgKey.rawKey))
            .send(MINIMAL_SBOM);

        expect(response.status).toBe(403);
        expect(response.body.error).toMatch(/cluster-scoped/i);

        // Nothing was written on the way to the refusal.
        expect(await db.select().from(schema.images)).toHaveLength(0);
        expect(await db.select().from(schema.sboms)).toHaveLength(0);
    });

    it("rejects a workload link from an org-scoped key with 403", async () => {
        const db = getTestDb();
        const orgKey = await createApiKey(db, testData.org.id, testData.user.id);

        const response = await request(app)
            .post(
                `/v1/sboms/upload/cyclonedx?imageDigest=${nextDigest()}` +
                `&namespace=production&workloadName=nginx&containerName=web`,
            )
            .set(createApiKeyHeaders(orgKey.rawKey))
            .send(MINIMAL_SBOM);

        expect(response.status).toBe(403);
        expect(response.body.error).toMatch(/cluster-scoped/i);
    });

    it("is idempotent for the same image and container", async () => {
        const db = getTestDb();
        const digest = nextDigest();
        const url =
            `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
            `&namespace=production&workloadName=nginx&containerName=web`;

        await request(app)
            .post(url)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        // The second upload is a duplicate SBOM, but the link is still the truth.
        await request(app)
            .post(url)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(409);

        expect(await db.select().from(schema.images)).toHaveLength(1);
        expect(await db.select().from(schema.workloadContainers)).toHaveLength(1);
        expect(await db.select().from(schema.sboms)).toHaveLength(1);
    });

    /**
     * The measurable win. Five namespaces, one digest: one image row, one SBOM,
     * one matching pass — where the old model produced five of each.
     */
    it("stores one SBOM for one digest running in five namespaces", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        for (const ns of ["a", "b", "c", "d", "e"]) {
            const url =
                `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
                `&namespace=${ns}&workloadName=nginx&containerName=web`;
            await request(app)
                .post(url)
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(MINIMAL_SBOM);
        }

        expect(await db.select().from(schema.images)).toHaveLength(1);
        expect(await db.select().from(schema.sboms)).toHaveLength(1);
        expect(await db.select().from(schema.namespaces)).toHaveLength(5);
        expect(await db.select().from(schema.workloadContainers)).toHaveLength(5);
    });

    /**
     * The other half of ADR 0006: dedup stops at the cluster boundary. The
     * same digest uploaded from two clusters of one org is two images and two
     * SBOMs — `sboms_image_id_unique` cannot fire across clusters because the
     * image rows are distinct.
     */
    it("stores a second image and SBOM for the same digest from a sibling cluster", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(testData.apiKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const siblingCluster = await createCluster(db, testData.org.id, { name: "staging" });
        const siblingKey = await createClusterApiKey(
            db,
            siblingCluster.id,
            testData.org.id,
            testData.user.id,
        );

        await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(siblingKey.rawKey))
            .send(MINIMAL_SBOM)
            .expect(201);

        const images = await db
            .select()
            .from(schema.images)
            .where(eq(schema.images.digest, digest));
        expect(images).toHaveLength(2);
        expect(new Set(images.map((i) => i.clusterId))).toEqual(
            new Set([testData.cluster.id, siblingCluster.id]),
        );
        expect(await db.select().from(schema.sboms)).toHaveLength(2);

        // Within one cluster the duplicate is still refused.
        const duplicate = await request(app)
            .post(`/v1/sboms/upload/cyclonedx?imageDigest=${digest}`)
            .set(createApiKeyHeaders(siblingKey.rawKey))
            .send(MINIMAL_SBOM);
        expect(duplicate.status).toBe(409);
    });

    it("exposes the five deployments through the workloads API", async () => {
        const db = getTestDb();
        const digest = nextDigest();

        for (const ns of ["a", "b", "c"]) {
            await request(app)
                .post(
                    `/v1/sboms/upload/cyclonedx?imageDigest=${digest}` +
                    `&namespace=${ns}&workloadName=nginx&containerName=web`,
                )
                .set(createApiKeyHeaders(testData.apiKey.rawKey))
                .send(MINIMAL_SBOM);
        }

        const [image] = await db
            .select()
            .from(schema.images)
            .where(eq(schema.images.digest, digest));

        const response = await request(app)
            .get(`/api/images/${image!.id}/deployments`)
            .set(createInternalHeaders({
                id: testData.user.id,
                email: testData.user.email,
                orgId: testData.org.id,
                orgName: testData.org.name,
                orgSlug: testData.org.slug,
            }));

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(3);
    });
});
