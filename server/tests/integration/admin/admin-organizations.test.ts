/**
 * The admin dashboard's view of `organizations`: the tenant list behind the
 * Organizations tab and the Explorer's picker, and the tenant figures on the
 * Overview.
 *
 * Two things these must get right, and both were wrong before this file:
 *
 * - The platform org (`services/platform.service.ts`) is StackRadar's own —
 *   nobody can join it, nothing can be minted for it — and it is not a
 *   tenant. Listed, it read as a customer with no members; counted, it put a
 *   phantom org in the per-plan split.
 * - Each row's limits come from `getPlanLimits`, the one rule every other
 *   limit check uses, so the community edition's org (stored plan
 *   `community`) is drawn against the community plan's caps rather than a
 *   client-side fallback to free — "3 / 1 members" on a three-member install.
 *
 * The repositories are imported dynamically: `src/db/index.ts` reads
 * DATABASE_URL at module load and test-setup.ts only sets it in its own
 * beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrganization, createOrgWithOwner } from "../../fixtures/seed-data.js";
import { edition } from "../../../src/edition.js";
import { PLAN_LIMITS } from "../../../src/config/plans.js";
import * as schema from "../../../src/db/schema/index.js";

let adminRepository: typeof import("../../../src/repositories/admin.repository.js").adminRepository;
let adminStatusRepository: typeof import("../../../src/repositories/admin-status.repository.js").adminStatusRepository;

beforeAll(async () => {
    adminRepository = (await import("../../../src/repositories/admin.repository.js")).adminRepository;
    adminStatusRepository = (await import("../../../src/repositories/admin-status.repository.js"))
        .adminStatusRepository;
});

beforeEach(async () => {
    await cleanAllData();
});

describe("getRecentOrganizations", () => {
    it("leaves the platform org out — it is not a tenant", async () => {
        const db = getTestDb();
        const tenant = await createOrgWithOwner(db);
        await createOrganization(db, { name: "StackRadar Platform", slug: "stackradar-platform", system: true });

        const orgs = await adminRepository.getRecentOrganizations();

        expect(orgs.map((o) => o.id)).toEqual([tenant.org.id]);
    });

    it("carries each org's effective limits, resolved by the server's plan rule", async () => {
        const db = getTestDb();
        const { org } = await createOrgWithOwner(db, {}, { plan: "community" });

        const [row] = await adminRepository.getRecentOrganizations();

        expect(row?.id).toBe(org.id);
        // The community edition has one plan whatever the column says; on the
        // cloud the stored value is read as-is — and `community` is a plan it
        // knows, so both editions land on the same uncapped limits here.
        expect(row?.limits).toEqual({ members: null, clusters: null, sboms: null });
    });

    it.skipIf(!edition.isCloud)("draws a free org against the free caps on the cloud", async () => {
        const db = getTestDb();
        await createOrgWithOwner(db, {}, { plan: "free" });

        const [row] = await adminRepository.getRecentOrganizations();

        expect(row?.limits).toEqual({
            members: PLAN_LIMITS.free.members,
            clusters: PLAN_LIMITS.free.clusters,
            sboms: null,
        });
    });
});

describe("getOrgRoles", () => {
    it("lists every membership of every tenant org, and none of the platform's", async () => {
        const db = getTestDb();
        const { user, org } = await createOrgWithOwner(db);
        const platform = await createOrganization(db, { slug: "stackradar-platform", system: true });
        // The repository refuses members on a system org, so the row is written directly.
        await db.insert(schema.orgMembers).values({ orgId: platform.id, userId: user.id, role: "admin" });

        const roles = await adminRepository.getOrgRoles();

        expect(roles).toEqual([
            { userId: user.id, orgId: org.id, orgName: org.name, orgSlug: org.slug, role: "owner" },
        ]);
    });
});

describe("getSystemStats().organizations", () => {
    it("counts tenants only, in the total and in the per-plan split", async () => {
        const db = getTestDb();
        await createOrgWithOwner(db, {}, { plan: "pro" });
        await createOrganization(db, { name: "StackRadar Platform", slug: "stackradar-platform", system: true });

        const stats = await adminStatusRepository.getSystemStats();

        expect(stats.organizations.total).toBe(1);
        expect(stats.organizations.byPlan).toEqual({ pro: 1 });
    });
});
