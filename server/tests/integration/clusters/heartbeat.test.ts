/**
 * The heartbeat's `X-Kubernetes-Version` header, which the chart-version
 * recommendations read for `kubeVersion` constraints.
 *
 * The load-bearing assertion is the negative one: an absent header leaves the
 * stored version unchanged. An older scanner, or one whose `/version` read
 * failed, must not erase knowledge a newer one recorded.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

describe("POST /v1/heartbeat — Kubernetes version reporting", () => {
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

    async function storedVersion(): Promise<string | null> {
        const [row] = await getTestDb()
            .select({ v: schema.clusters.kubernetesVersion })
            .from(schema.clusters)
            .where(eq(schema.clusters.id, clusterId));
        return row?.v ?? null;
    }

    it("records the version from the header", async () => {
        const res = await request(app)
            .post("/v1/heartbeat")
            .set(createApiKeyHeaders(clusterKey))
            .set("X-Kubernetes-Version", "v1.29.4+k3s1");
        expect(res.status).toBe(200);
        expect(await storedVersion()).toBe("v1.29.4+k3s1");
    });

    it("leaves the stored version unchanged when the header is absent", async () => {
        await request(app)
            .post("/v1/heartbeat")
            .set(createApiKeyHeaders(clusterKey))
            .set("X-Kubernetes-Version", "v1.30.2");

        // A later heartbeat without the header — an older scanner, or a
        // failed /version read — must not erase what we know.
        const res = await request(app).post("/v1/heartbeat").set(createApiKeyHeaders(clusterKey));
        expect(res.status).toBe(200);
        expect(await storedVersion()).toBe("v1.30.2");
    });

    it("stays null when no heartbeat ever carried the header", async () => {
        const res = await request(app).post("/v1/heartbeat").set(createApiKeyHeaders(clusterKey));
        expect(res.status).toBe(200);
        expect(await storedVersion()).toBeNull();
    });

    it("trims and caps a pathological header value at the column width", async () => {
        await request(app)
            .post("/v1/heartbeat")
            .set(createApiKeyHeaders(clusterKey))
            .set("X-Kubernetes-Version", "  " + "v1.29.4+".padEnd(200, "x") + "  ");
        const stored = await storedVersion();
        expect(stored).toHaveLength(64);
        expect(stored!.startsWith("v1.29.4+")).toBe(true);
    });
});
