/**
 * `GET /api/feed?image=` — one image's history: the image page's History
 * tab. The events are written by the inventory path, so the seed here is
 * what a scanner does: successive full-set reports that bring a container
 * up on a digest, move it to another and drop a second one.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getTestApp, createApiKeyHeaders, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    createImage,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

function container(digest: string, tag: string) {
    return {
        name: "api",
        init: false,
        imageRef: `ghcr.io/acme/api:${tag}`,
        imageDigest: digest,
        imageTag: tag,
        registry: "ghcr.io",
        repository: "acme/api",
        runningPods: 1,
    };
}

function workload(name: string, digest: string, tag: string) {
    return {
        kind: "Deployment",
        name,
        release: null,
        application: null,
        runningPods: 1,
        firstStartedAt: "2026-07-02T10:00:00.000Z",
        containers: [container(digest, tag)],
    };
}

function report(workloads: unknown[]) {
    return {
        version: 3,
        reportedAt: new Date().toISOString(),
        informerSynced: true,
        ownerMetadataCollected: true,
        releases: [],
        applications: [],
        namespaces: [{ name: "prod", labels: {}, workloads }],
    };
}

describe("GET /api/feed?image=", () => {
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

    function headers() {
        return createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id });
    }

    async function post(body: object) {
        const res = await request(app).post("/v1/inventory").set(createApiKeyHeaders(clusterKey)).send(body);
        expect(res.status).toBe(200);
    }

    /** The image row the inventory created for a digest in this cluster (ADR 0006: identity is cluster + digest). */
    async function imageIdOf(digest: string): Promise<string> {
        const [row] = await getTestDb()
            .select({ id: schema.images.id })
            .from(schema.images)
            .where(and(eq(schema.images.clusterId, clusterId), eq(schema.images.digest, digest)));
        expect(row).toBeDefined();
        return row!.id;
    }

    /** Two slots come up on A and B; then `web` moves A → C and `worker` leaves. */
    async function seedTwoImagesWithHistory() {
        await post(report([workload("web", DIGEST_A, "1.26"), workload("worker", DIGEST_B, "2.0")]));
        await post(report([workload("web", DIGEST_C, "1.27")]));
        return { a: await imageIdOf(DIGEST_A), b: await imageIdOf(DIGEST_B), c: await imageIdOf(DIGEST_C) };
    }

    it("returns only the events about that image, the move off it included", async () => {
        const { a, b } = await seedTwoImagesWithHistory();

        const res = await request(app).get(`/api/feed?image=${a}`).set(headers());

        expect(res.status).toBe(200);
        const types = res.body.events.map((e: { type: string }) => e.type);
        // Newest first: the move that left A, then the appearance on A.
        expect(types).toEqual(["container.image-changed", "container.appeared"]);
        for (const e of res.body.events) {
            const touchesA = e.imageId === a || e.payload.from?.imageId === a;
            expect(touchesA).toBe(true);
            expect(e.payload.workloadName).toBe("web");
        }
        // Nothing about `worker`, which never ran A.
        expect(res.body.events.some((e: { imageId: string | null }) => e.imageId === b)).toBe(false);
        expect(res.body.nextCursor).toBeNull();
    });

    it("gives the other image its own history", async () => {
        const { b } = await seedTwoImagesWithHistory();

        const res = await request(app).get(`/api/feed?image=${b}`).set(headers());

        expect(res.status).toBe(200);
        expect(res.body.events.map((e: { type: string }) => e.type)).toEqual([
            "container.removed",
            "container.appeared",
        ]);
        for (const e of res.body.events) {
            expect(e.imageId).toBe(b);
            expect(e.payload.workloadName).toBe("worker");
        }
    });

    it("lists the digest a slot moved onto under that image", async () => {
        const { c } = await seedTwoImagesWithHistory();

        const res = await request(app).get(`/api/feed?image=${c}`).set(headers());

        expect(res.body.events.map((e: { type: string }) => e.type)).toEqual(["container.image-changed"]);
        expect(res.body.events[0].imageId).toBe(c);
    });

    it("rejects a malformed image id", async () => {
        const res = await request(app).get("/api/feed?image=not-an-id").set(headers());
        expect(res.status).toBe(400);
    });

    it("answers an empty page for another org's image, never a 404", async () => {
        await seedTwoImagesWithHistory();
        const db = getTestDb();
        const stranger = await createOrgWithOwner(db, { email: "stranger@test.com" }, { slug: "stranger-org" });
        const strangerCluster = await createCluster(db, stranger.org.id, { name: "theirs" });
        const strangerImage = await createImage(db, stranger.org.id, strangerCluster.id, {
            digest: `sha256:${"d".repeat(64)}`,
        });
        await db.insert(schema.activityEvents).values({
            orgId: stranger.org.id,
            clusterId: strangerCluster.id,
            type: "container.appeared",
            imageId: strangerImage.id,
            payload: {},
        });

        const res = await request(app).get(`/api/feed?image=${strangerImage.id}`).set(headers());

        expect(res.status).toBe(200);
        expect(res.body.events).toEqual([]);
    });

    it("answers an empty page for an image id nothing has happened to", async () => {
        const res = await request(app).get(`/api/feed?image=${randomUUID()}`).set(headers());
        expect(res.status).toBe(200);
        expect(res.body.events).toEqual([]);
    });
});
