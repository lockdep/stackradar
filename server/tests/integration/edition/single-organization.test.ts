import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createApiKeyHeaders, createInternalHeaders, getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createUser } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

/**
 * The community edition's single organisation and single cluster
 * (docs/open-source-plan-2026-10-10.md step 03). The suite runs as the
 * cloud by default, so this file pins the process's edition to community
 * before anything imports it: every module that reads `edition` — the
 * routes' gates, `getPlanLimits`, the setup controller — sees the
 * community capabilities, which is the only honest way to test a rule
 * that is "what this edition refuses".
 */
vi.mock("../../../src/edition.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/edition.js")>();
    return { ...actual, edition: actual.resolveEdition("community") };
});

const BOOTSTRAP = {
    clusterId: "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    apiKey: "bootstrap-key-0123456789abcdefghijklmnop",
};

async function defaultOrg() {
    return import("../../../src/services/default-org.service.js");
}

/** `POST /api/users/setup` as `user`: the first-login path. No org header — the user has none yet. */
function setup(app: Express, user: { id: string; email: string; name: string | null }) {
    return request(app)
        .post("/api/users/setup")
        .set(createInternalHeaders({ id: user.id, email: user.email, ...(user.name ? { name: user.name } : {}) }))
        .send({});
}

describe("community edition: one organisation, one cluster", () => {
    let app: Express;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
    });

    describe("first login", () => {
        it("makes the first user the owner of `default` and every later one a member", async () => {
            const db = getTestDb();
            const first = await createUser(db, { email: "first@community.test", name: "First" });
            const second = await createUser(db, { email: "second@community.test", name: "Second" });

            const a = await setup(app, first);
            expect(a.status).toBe(201);
            expect(a.body.organization).toMatchObject({ slug: "default", plan: "community", role: "owner" });

            const b = await setup(app, second);
            expect(b.status).toBe(201);
            expect(b.body.organization).toMatchObject({ id: a.body.organization.id, slug: "default", role: "member" });

            // No "<name>'s Organization" was created for either of them.
            const orgs = await db.select({ slug: schema.organizations.slug }).from(schema.organizations);
            expect(orgs.map((o) => o.slug)).toEqual(["default"]);

            // Logging in again is a no-op that reports the existing membership.
            const again = await setup(app, second);
            expect(again.status).toBe(200);
            expect(again.body.organization).toMatchObject({ id: a.body.organization.id, role: "member" });
        });

        it("seeds the default organisation itself when the start-up seed has not run", async () => {
            const { findDefaultOrganization } = await defaultOrg();
            expect(await findDefaultOrganization()).toBeNull();

            const user = await createUser(getTestDb(), { email: "solo@community.test" });
            const res = await setup(app, user);
            expect(res.status).toBe(201);
            expect(await findDefaultOrganization()).toEqual({ orgId: res.body.organization.id });
        });
    });

    describe("what the edition refuses", () => {
        let owner: schema.User;
        let orgId: string;

        const ownerHeaders = () =>
            createInternalHeaders({ id: owner.id, email: owner.email, orgId, orgName: "Default organization", orgSlug: "default", orgPlan: "community" });

        beforeEach(async () => {
            owner = await createUser(getTestDb(), { email: "owner@community.test" });
            const res = await setup(app, owner);
            orgId = res.body.organization.id;
        });

        it("a second organisation: 403 single_organization", async () => {
            const res = await request(app)
                .post("/api/users/organizations")
                .set(createInternalHeaders({ id: owner.id, email: owner.email }))
                .send({ name: "Another" });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe("single_organization");
            expect(res.body.error).toMatch(/one organisation/i);
        });

        it("a second cluster: 403 single_cluster, even for the owner", async () => {
            const res = await request(app).post("/api/clusters").set(ownerHeaders()).send({ name: "staging" });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe("single_cluster");
            expect(res.body.error).toMatch(/StackRadar Cloud/);
            const clusters = await getTestDb().select().from(schema.clusters);
            expect(clusters).toHaveLength(0);
        });

        it("rotating or revoking the scanner key from a request: 403 single_cluster; reading and revealing it still work", async () => {
            const { ensureDefaultOrganization } = await defaultOrg();
            await ensureDefaultOrganization(BOOTSTRAP);

            const rotate = await request(app).post(`/api/clusters/${BOOTSTRAP.clusterId}/api-key`).set(ownerHeaders());
            expect(rotate.status).toBe(403);
            expect(rotate.body.code).toBe("single_cluster");

            const revoke = await request(app).delete(`/api/clusters/${BOOTSTRAP.clusterId}/api-key`).set(ownerHeaders());
            expect(revoke.status).toBe(403);
            expect(revoke.body.code).toBe("single_cluster");

            // The admin UI shows the key with its prefix.
            const masked = await request(app).get(`/api/clusters/${BOOTSTRAP.clusterId}/api-key`).set(ownerHeaders());
            expect(masked.status).toBe(200);
            expect(masked.body.apiKey).toMatch(new RegExp(`^${BOOTSTRAP.apiKey.slice(0, 8)}`));

            const list = await request(app).get("/api/clusters/api-keys").set(ownerHeaders());
            expect(list.status).toBe(200);
            expect(list.body.clusters).toHaveLength(1);
            expect(list.body.clusters[0]).toMatchObject({ id: BOOTSTRAP.clusterId, name: "local" });
            expect(list.body.clusters[0].key.apiKey).toMatch(new RegExp(`^${BOOTSTRAP.apiKey.slice(0, 8)}`));

            // The vault is on in tests, so the env-provided key is revealable too.
            const reveal = await request(app).post(`/api/clusters/${BOOTSTRAP.clusterId}/api-key/reveal`).set(ownerHeaders());
            expect(reveal.status).toBe(200);
            expect(reveal.body.apiKey).toBe(BOOTSTRAP.apiKey);
        });
    });

    describe("ensureDefaultOrganization", () => {
        it("is idempotent for the organisation", async () => {
            const { ensureDefaultOrganization, findDefaultOrganization } = await defaultOrg();
            const first = await ensureDefaultOrganization();
            const second = await ensureDefaultOrganization();
            expect(second).toEqual(first);
            expect(first.clusterId).toBeNull();
            expect(await findDefaultOrganization()).toEqual({ orgId: first.orgId });

            const [org] = await getTestDb().select().from(schema.organizations).where(eq(schema.organizations.id, first.orgId));
            expect(org).toMatchObject({ slug: "default", plan: "community", system: false, demo: false });
        });

        it("creates the bootstrap cluster `local` with the configured id and a key the scanner can authenticate with", async () => {
            const { ensureDefaultOrganization } = await defaultOrg();
            const seeded = await ensureDefaultOrganization(BOOTSTRAP);
            expect(seeded.clusterId).toBe(BOOTSTRAP.clusterId);

            const db = getTestDb();
            const [cluster] = await db.select().from(schema.clusters).where(eq(schema.clusters.id, BOOTSTRAP.clusterId));
            expect(cluster).toMatchObject({ orgId: seeded.orgId, name: "local", system: false });

            const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.clusterId, BOOTSTRAP.clusterId));
            expect(keys).toHaveLength(1);
            expect(keys[0]).toMatchObject({
                orgId: seeded.orgId,
                createdBy: null,
                isActive: true,
                keyPrefix: BOOTSTRAP.apiKey.slice(0, 8),
                scopes: ["sbom:write"],
            });
            expect(keys[0]!.keyCiphertext).not.toBeNull();

            // The scanner's first call: authenticated as this cluster.
            const check = await request(app)
                .get("/v1/sboms/check?imageDigest=sha256:0000000000000000000000000000000000000000000000000000000000000000")
                .set(createApiKeyHeaders(BOOTSTRAP.apiKey));
            expect(check.status).toBe(200);
            expect(check.body.exists).toBe(false);
        });

        it("re-running with the same values is a no-op; a changed key rotates", async () => {
            const { ensureDefaultOrganization } = await defaultOrg();
            const db = getTestDb();
            await ensureDefaultOrganization(BOOTSTRAP);
            const [before] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.clusterId, BOOTSTRAP.clusterId));

            await ensureDefaultOrganization(BOOTSTRAP);
            const unchanged = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.clusterId, BOOTSTRAP.clusterId));
            expect(unchanged).toHaveLength(1);
            expect(unchanged[0]!.id).toBe(before!.id);

            const rotated = { ...BOOTSTRAP, apiKey: "rotated-key-0123456789abcdefghijklmnop" };
            await ensureDefaultOrganization(rotated);
            const after = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.clusterId, BOOTSTRAP.clusterId));
            expect(after).toHaveLength(2);
            const old = after.find((k) => k.id === before!.id)!;
            expect(old.isActive).toBe(false);
            expect(old.revokedAt).not.toBeNull();
            const [active] = await db
                .select()
                .from(schema.apiKeys)
                .where(and(eq(schema.apiKeys.clusterId, BOOTSTRAP.clusterId), eq(schema.apiKeys.isActive, true)));
            expect(active!.keyPrefix).toBe(rotated.apiKey.slice(0, 8));

            const stale = await request(app).get("/v1/sboms/check?imageDigest=sha256:abc").set(createApiKeyHeaders(BOOTSTRAP.apiKey));
            expect(stale.status).toBe(401);
            const fresh = await request(app).get("/v1/sboms/check?imageDigest=sha256:abc").set(createApiKeyHeaders(rotated.apiKey));
            expect(fresh.status).not.toBe(401);

            // Still one cluster: a rotation is not a second cluster.
            expect(await db.select().from(schema.clusters)).toHaveLength(1);
        });

        it("refuses a cluster id that belongs to another organisation", async () => {
            const { ensureDefaultOrganization, DefaultOrganizationError } = await defaultOrg();
            const db = getTestDb();
            const [other] = await db
                .insert(schema.organizations)
                .values({ name: "Someone else", slug: "someone-else" })
                .returning({ id: schema.organizations.id });
            await db.insert(schema.clusters).values({ id: BOOTSTRAP.clusterId, orgId: other!.id, name: "theirs" });

            await expect(ensureDefaultOrganization(BOOTSTRAP)).rejects.toThrow(DefaultOrganizationError);
        });
    });
});
