/**
 * The `images` row trusts `imageRef` over the cosmetic registry/repository
 * fields.
 *
 * The ref comes from the runtime's `imageID` and always names the real
 * repository; the explicit fields are parsed by the agent from a *display*
 * name, which for a digest-pinned pod is a bare config hash — agents ≤0.1.7
 * sent `repository: 'sha256'` from exactly that, collapsing every
 * digest-pinned image in a fleet into one fake `sha256` project. The server
 * now derives provenance from the ref first and uses the explicit fields only
 * when the ref yields none, so a not-yet-upgraded (or foreign) agent cannot
 * recreate those rows.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
/* The bare image ID containerd reports for a digest-pinned pod: a config
   hash, not a name. */
const BARE_ID = `sha256:${"d".repeat(64)}`;

function report(container: Record<string, unknown>) {
    return {
        version: 3,
        reportedAt: "2026-08-18T09:00:00.000Z",
        informerSynced: true,
        ownerMetadataCollected: true,
        releases: [],
        applications: [],
        namespaces: [
            {
                name: "default",
                labels: {},
                workloads: [
                    {
                        kind: "Deployment",
                        name: "api",
                        release: null,
                        application: null,
                        runningPods: 1,
                        firstStartedAt: null,
                        containers: [
                            {
                                name: "main",
                                init: false,
                                imageDigest: DIGEST,
                                imageTag: null,
                                runningPods: 1,
                                ...container,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

describe("POST /v1/inventory — image provenance comes from the ref", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;
    let clusterKey: string;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await createOrgWithOwner(db);
        const cluster = await createCluster(db, testData.org.id);
        ({ rawKey: clusterKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id));
    });

    function post(body: object) {
        return request(app).post("/v1/inventory").set(createApiKeyHeaders(clusterKey)).send(body);
    }

    async function image() {
        const [row] = await getTestDb()
            .select()
            .from(schema.images)
            .where(eq(schema.images.digest, DIGEST));
        return row;
    }

    it("prefers the ref over wrong explicit fields — the 0.1.7 digest-pinned shape", async () => {
        const res = await post(
            report({
                imageRef: `registry.digitalocean.com/stack-radar/stack-radar-server@${DIGEST}`,
                // What a ≤0.1.7 agent sends after parsing the bare image ID as
                // a display name.
                registry: null,
                repository: "sha256",
            })
        );

        expect(res.status).toBe(200);
        expect(await image()).toMatchObject({
            registry: "registry.digitalocean.com",
            repository: "stack-radar/stack-radar-server",
        });
    });

    it("falls back to the explicit fields when the ref is a bare image ID", async () => {
        const res = await post(
            report({
                imageRef: BARE_ID,
                registry: "ghcr.io",
                repository: "acme/api",
            })
        );

        expect(res.status).toBe(200);
        // The empty parse of a digest-only ref must not clobber real values.
        expect(await image()).toMatchObject({ registry: "ghcr.io", repository: "acme/api" });
    });
});
