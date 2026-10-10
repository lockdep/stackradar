/**
 * `seedDemo` — docs/live-demo/ step 01. Idempotent, prints the key once,
 * rotation leaves exactly one active key, never deletes.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { CURRENT_TERMS_VERSION } from "../../../src/cloud/terms/version.js";

async function seed() {
    return import("../../../src/cloud/demo/demo-seed.service.js");
}

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("seedDemo", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("creates the fixture once and is a no-op the second time", async () => {
        const { seedDemo, DEMO_USER_EMAIL, DEMO_ORG_SLUG, DEMO_CLUSTER_NAME } = await seed();
        const db = getTestDb();

        const first = await seedDemo();
        expect(first.created).toEqual({ user: true, org: true, membership: true, cluster: true });
        expect(first.apiKey).toMatch(/^[A-Za-z0-9_-]{32}$/);

        const second = await seedDemo();
        expect(second.created).toEqual({ user: false, org: false, membership: false, cluster: false });
        expect(second.apiKey).toBeUndefined();
        expect({ userId: second.userId, orgId: second.orgId, clusterId: second.clusterId }).toEqual({
            userId: first.userId,
            orgId: first.orgId,
            clusterId: first.clusterId,
        });

        const users = await db.select().from(schema.users).where(eq(schema.users.email, DEMO_USER_EMAIL));
        expect(users).toHaveLength(1);
        expect(users[0]?.demo).toBe(true);
        expect(users[0]?.emailVerified).not.toBeNull();

        const orgs = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, DEMO_ORG_SLUG));
        expect(orgs).toHaveLength(1);
        expect(orgs[0]).toMatchObject({ demo: true, plan: "team", stripeCustomerId: null, stripeSubscriptionId: null });

        const members = await db.select().from(schema.orgMembers).where(eq(schema.orgMembers.orgId, first.orgId));
        expect(members).toEqual([expect.objectContaining({ userId: first.userId, role: "member" })]);

        const clusters = await db.select().from(schema.clusters).where(eq(schema.clusters.orgId, first.orgId));
        expect(clusters).toHaveLength(1);
        expect(clusters[0]?.name).toBe(DEMO_CLUSTER_NAME);

        const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.clusterId, first.clusterId));
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatchObject({ isActive: true, scopes: ["sbom:write"] });

        const terms = await db.select().from(schema.termsAcceptances).where(eq(schema.termsAcceptances.userId, first.userId));
        expect(terms).toEqual([expect.objectContaining({ termsVersion: CURRENT_TERMS_VERSION })]);
    });

    it("--rotate-key revokes the old key and leaves exactly one active", async () => {
        const { seedDemo } = await seed();
        const db = getTestDb();

        const first = await seedDemo();
        const rotated = await seedDemo({ rotateKey: true });

        expect(rotated.created.cluster).toBe(false);
        expect(rotated.apiKey).toBeDefined();
        expect(rotated.apiKey).not.toBe(first.apiKey);

        const active = await db
            .select()
            .from(schema.apiKeys)
            .where(and(eq(schema.apiKeys.clusterId, first.clusterId), eq(schema.apiKeys.isActive, true)));
        expect(active).toHaveLength(1);
        const all = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.clusterId, first.clusterId));
        expect(all).toHaveLength(2);
    });

    it("keeps the demo org out of the platform metrics sweeps", async () => {
        const { seedDemo } = await seed();
        const { metricsRepository } = await import("../../../src/repositories/metrics.repository.js");
        const { createOrgWithOwner, createCluster } = await import("../../fixtures/seed-data.js");
        const db = getTestDb();

        const tenant = await createOrgWithOwner(db);
        const tenantCluster = await createCluster(db, tenant.org.id);
        await seedDemo();

        expect(await metricsRepository.findAllOrgIds()).toEqual([tenant.org.id]);
        expect(await metricsRepository.findAllClusterIds()).toEqual([tenantCluster.id]);
    });

    it("flags the admin org list", async () => {
        const { seedDemo } = await seed();
        const { adminRepository } = await import("../../../src/repositories/admin.repository.js");
        const db = getTestDb();
        const { createOrgWithOwner } = await import("../../fixtures/seed-data.js");
        const tenant = await createOrgWithOwner(db);
        const demo = await seedDemo();

        const orgs = await adminRepository.getRecentOrganizations();
        const byId = new Map(orgs.map((o) => [o.id, o.demo]));
        expect(byId.get(demo.orgId)).toBe(true);
        expect(byId.get(tenant.org.id)).toBe(false);
    });
});
