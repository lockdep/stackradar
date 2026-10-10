/**
 * The platform org/cluster boundary — measuring-candidate-charts.md phase 3.
 *
 * The acceptance criterion under test: **no API key can be created for a
 * system org or cluster, enforced in code**. A key for the platform cluster
 * would be a credential that can write SBOMs every tenant's suggestions read
 * — the poisoning shape ADR 0006 closed — so the guard sits on the only two
 * key-write paths, and membership is refused at the only member-write path.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

async function platform() {
    return import("../../../src/services/platform.service.js");
}

async function clusterRepo() {
    const { clusterRepository } = await import("../../../src/repositories/cluster.repository.js");
    return clusterRepository;
}

describe("ensurePlatform", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("seeds the system org and cluster once, idempotently, with no API key", async () => {
        const { ensurePlatform, findPlatform } = await platform();

        expect(await findPlatform()).toBeNull();

        const first = await ensurePlatform();
        const second = await ensurePlatform();
        expect(second).toEqual(first);
        expect(await findPlatform()).toEqual(first);

        const db = getTestDb();
        const [org] = await db
            .select()
            .from(schema.organizations)
            .where(eq(schema.organizations.id, first.orgId));
        const [cluster] = await db
            .select()
            .from(schema.clusters)
            .where(eq(schema.clusters.id, first.clusterId));
        expect(org?.system).toBe(true);
        expect(cluster?.system).toBe(true);

        const keys = await db
            .select()
            .from(schema.apiKeys)
            .where(eq(schema.apiKeys.orgId, first.orgId));
        expect(keys).toHaveLength(0);
    });
});

describe("system org and cluster guards", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("refuses to mint a key by creating a cluster under the system org", async () => {
        const db = getTestDb();
        const { user } = await seedTestScenario(db);
        const { ensurePlatform } = await platform();
        const { orgId } = await ensurePlatform();
        const repo = await clusterRepo();

        await expect(
            repo.createWithApiKey({ orgId, name: "sneaky" }, user.id)
        ).rejects.toThrow(/system organization/);

        // The guard aborted the whole transaction: no cluster row either.
        const clusters = await db
            .select()
            .from(schema.clusters)
            .where(eq(schema.clusters.orgId, orgId));
        expect(clusters.map((c) => c.name)).toEqual(["platform-scanner"]);
    });

    it("refuses to create any cluster flagged system with a key", async () => {
        const db = getTestDb();
        const { org, user } = await seedTestScenario(db);
        const repo = await clusterRepo();

        await expect(
            repo.createWithApiKey({ orgId: org.id, name: "fake-platform", system: true }, user.id)
        ).rejects.toThrow(/system cluster/);
    });

    it("refuses to rotate a key for the system cluster", async () => {
        const db = getTestDb();
        const { user } = await seedTestScenario(db);
        const { ensurePlatform } = await platform();
        const { orgId, clusterId } = await ensurePlatform();
        const repo = await clusterRepo();

        await expect(repo.rotateApiKey(clusterId, orgId, user.id)).rejects.toThrow(/system/);

        const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
        expect(keys).toHaveLength(0);
    });

    it("refuses membership in the system org", async () => {
        const db = getTestDb();
        const { user } = await seedTestScenario(db);
        const { ensurePlatform } = await platform();
        const { orgId } = await ensurePlatform();

        const { organizationRepository } = await import("../../../src/repositories/organization.repository.js");
        await expect(organizationRepository.addOrgMember(orgId, user.id, "member")).rejects.toThrow(/system organization/);
    });

    it("leaves ordinary orgs and clusters untouched by the guards", async () => {
        const db = getTestDb();
        const { org, user } = await seedTestScenario(db);
        const repo = await clusterRepo();

        const created = await repo.createWithApiKey({ orgId: org.id, name: "normal" }, user.id);
        expect(created.apiKey).toBeTruthy();
        const rotated = await repo.rotateApiKey(created.cluster.id, org.id, user.id);
        expect(rotated).toBeTruthy();
    });
});
