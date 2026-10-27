/**
 * The demo context is read-only.
 *
 * Two flags, two guards: `organizations.demo` is refused in `requireOrg`
 * (every org-scoped route), `users.demo` in `requireAuth` (the routes with
 * no org context). Both answer `403` with `code: read_only_demo`, which is
 * what the client banner matches on. API-key ingest into the demo cluster
 * is deliberately untouched — the demo reporter is what keeps the exhibit
 * fresh — and a non-demo org and user in the same file prove the guard is
 * scoped, not global.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createUser,
    createOrganization,
    addOrgMember,
    createCluster,
    createClusterApiKey,
    createOrgInvite,
    seedRunningImage,
    createSbom,
    createOrgWithOwner,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema/index.js";
import { READ_ONLY_DEMO_CODE } from "../../../src/lib/demo.js";

const DIGEST = `sha256:${"d".repeat(64)}`;

function inventoryReport() {
    return {
        version: 3,
        reportedAt: "2026-09-08T09:00:00.000Z",
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
                        firstStartedAt: "2026-09-01T10:00:00.000Z",
                        containers: [
                            {
                                name: "main",
                                init: false,
                                imageRef: `ghcr.io/acme/api@${DIGEST}`,
                                imageDigest: DIGEST,
                                imageTag: "1.0.0",
                                registry: "ghcr.io",
                                repository: "acme/api",
                                runningPods: 1,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("read-only demo guard", () => {
    let app: Express;
    let demoUser: schema.User;
    let demoOrg: schema.Organization;
    let demoCluster: schema.Cluster;
    let demoKey: string;
    let demoSbomId: string;
    let demoHeaders: Record<string, string>;
    let real: CreateOrgWithOwnerResult;
    let realCluster: schema.Cluster;
    let realHeaders: Record<string, string>;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();

        demoUser = await createUser(db, { email: "demo@stackradar.io", demo: true });
        demoOrg = await createOrganization(db, { slug: "demo", plan: "team", demo: true });
        await addOrgMember(db, demoUser.id, demoOrg.id, "member");
        demoCluster = await createCluster(db, demoOrg.id, { name: "platform-eu1" });
        demoKey = (await createClusterApiKey(db, demoCluster.id, demoOrg.id, demoUser.id)).rawKey;
        const running = await seedRunningImage(db, demoOrg.id, demoCluster.id);
        demoSbomId = (await createSbom(db, { imageId: running.image.id })).id;
        demoHeaders = createInternalHeaders({
            id: demoUser.id,
            email: demoUser.email,
            orgId: demoOrg.id,
            orgPlan: "team",
        });

        real = await createOrgWithOwner(db);
        realCluster = await createCluster(db, real.org.id);
        realHeaders = createInternalHeaders({ id: real.user.id, email: real.user.email, orgId: real.org.id });
    });

    describe("a member of the demo org", () => {
        it("reads everything", async () => {
            for (const path of [
                "/api/clusters",
                `/api/clusters/${demoCluster.id}`,
                "/api/containers",
                "/api/images",
                "/api/vulnerabilities",
                "/api/sboms",
                "/api/jobs",
                "/api/remediation/fixes",
            ]) {
                const res = await request(app).get(path).set(demoHeaders);
                expect(res.status, path).toBe(200);
            }
        });

        it("is refused every mutation with 403 read_only_demo", async () => {
            const attempts: Array<[string, request.Test]> = [
                ["DELETE sbom", request(app).delete(`/api/sboms/${demoSbomId}`)],
                ["POST cluster", request(app).post("/api/clusters").send({ name: "another" })],
                ["DELETE cluster", request(app).delete(`/api/clusters/${demoCluster.id}`)],
                [
                    "PATCH org settings",
                    request(app).patch(`/api/organizations/${demoOrg.id}`).send({ name: "Renamed" }),
                ],
            ];
            for (const [label, attempt] of attempts) {
                const res = await attempt.set(demoHeaders);
                expect(res.status, label).toBe(403);
                expect(res.body.code, label).toBe(READ_ONLY_DEMO_CODE);
            }

            // Nothing moved.
            const db = getTestDb();
            const [sbom] = await db.select().from(schema.sboms).where(eq(schema.sboms.id, demoSbomId));
            expect(sbom).toBeDefined();
            const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, demoOrg.id));
            expect(org?.name).toBe(demoOrg.name);
        });
    });

    describe("the demo user outside org context", () => {
        it("cannot create an organisation", async () => {
            const res = await request(app)
                .post("/api/users/organizations")
                .set(createInternalHeaders({ id: demoUser.id, email: demoUser.email }))
                .send({ name: "Escape Hatch" });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe(READ_ONLY_DEMO_CODE);
        });

        it("cannot send feedback", async () => {
            const res = await request(app)
                .post("/api/feedback")
                .set(demoHeaders)
                .send({ message: "hello from the demo" });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe(READ_ONLY_DEMO_CODE);
        });

        it("cannot accept an invite into a real org", async () => {
            const db = getTestDb();
            const invite = await createOrgInvite(db, real.org.id, real.user.id, { email: demoUser.email });
            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(createInternalHeaders({ id: demoUser.id, email: demoUser.email }));
            expect(res.status).toBe(403);
            expect(res.body.code).toBe(READ_ONLY_DEMO_CODE);
        });

        it("still reads its own org list and terms status", async () => {
            const orgs = await request(app)
                .get("/api/users/organizations")
                .set(createInternalHeaders({ id: demoUser.id, email: demoUser.email }));
            expect(orgs.status).toBe(200);
            const terms = await request(app)
                .get("/api/users/terms")
                .set(createInternalHeaders({ id: demoUser.id, email: demoUser.email }));
            expect(terms.status).toBe(200);
        });
    });

    describe("a real org and user in the same database", () => {
        it("mutates as before", async () => {
            // A paying org (the fixtures' default): the create goes through,
            // and nothing here is the demo guard. That distinction is the point.
            const create = await request(app).post("/api/clusters").set(realHeaders).send({ name: "prod-1" });
            expect(create.status).toBe(201);

            const rename = await request(app)
                .patch(`/api/organizations/${real.org.id}`)
                .set(realHeaders)
                .send({ name: "Renamed Org" });
            expect(rename.status).toBe(200);

            const del = await request(app).delete(`/api/clusters/${realCluster.id}`).set(realHeaders);
            expect(del.status).toBe(200);

            const feedback = await request(app).post("/api/feedback").set(realHeaders).send({ message: "works" });
            expect(feedback.status).toBe(201);
        });
    });

    describe("the demo cluster's scanner key", () => {
        it("keeps the whole /v1 ingest surface", async () => {
            const heartbeat = await request(app).post("/v1/heartbeat").set(createApiKeyHeaders(demoKey));
            expect(heartbeat.status).toBe(200);

            const inventory = await request(app)
                .post("/v1/inventory")
                .set(createApiKeyHeaders(demoKey))
                .send(inventoryReport());
            expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);

            const check = await request(app)
                .get(`/v1/sboms/check?imageDigest=${DIGEST}`)
                .set(createApiKeyHeaders(demoKey));
            expect(check.status).toBe(200);
        });
    });

    describe("membership", () => {
        it("refuses addOrgMember into the demo org", async () => {
            const { organizationRepository } = await import("../../../src/repositories/organization.repository.js");
            await expect(organizationRepository.addOrgMember(demoOrg.id, real.user.id, "admin")).rejects.toThrow(
                /demo organization/,
            );
        });
    });
});
