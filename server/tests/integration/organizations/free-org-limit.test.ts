import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createUser, createOrganization, addOrgMember } from "../../fixtures/seed-data.js";
import { organizations, type User } from "../../../src/db/schema/index.js";
import { edition } from "../../../src/edition.js";

/**
 * One free org per user (POST /api/users/organizations).
 *
 * Cluster limits are per org and every new org starts on the free plan, so
 * without this gate a user could take a second free cluster by creating a
 * second org. Upgrading or deleting the existing free org frees the slot.
 */
// Cloud-only: plans and the free-org limit are cloud billing; `STACKRADAR_EDITION=community pnpm test` skips it.
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Free org limit (POST /api/users/organizations)", () => {
    let app: Express;
    let user: User;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        user = await createUser(getTestDb(), { email: "user@test.com" });
    });

    function create(name: string) {
        return request(app)
            .post("/api/users/organizations")
            .set(createInternalHeaders({ id: user.id, email: user.email }))
            .send({ name });
    }

    it("should create a first org for a user with none", async () => {
        const res = await create("First Org");
        expect(res.status).toBe(201);
        expect(res.body.organization.name).toBe("First Org");
    });

    it("should reject a second org when the user already owns a free org", async () => {
        const db = getTestDb();
        const org = await createOrganization(db, { slug: "free-org", plan: "free" });
        await addOrgMember(db, user.id, org.id, "owner");

        const res = await create("Second Org");

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("FREE_ORG_LIMIT");
        expect(res.body.error).toMatch(/already have a free organization/i);
    });

    it("should reject when the user is a non-owner member of a free org", async () => {
        const db = getTestDb();
        const owner = await createUser(db, { email: "owner@test.com" });
        const org = await createOrganization(db, { slug: "free-org", plan: "free" });
        await addOrgMember(db, owner.id, org.id, "owner");
        await addOrgMember(db, user.id, org.id, "member");

        const res = await create("Second Org");
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("FREE_ORG_LIMIT");
    });

    it("should allow a new org when the user's existing orgs are all paid", async () => {
        const db = getTestDb();
        const pro = await createOrganization(db, { slug: "pro-org", plan: "pro" });
        await addOrgMember(db, user.id, pro.id, "owner");
        const team = await createOrganization(db, { slug: "team-org", plan: "team" });
        await addOrgMember(db, user.id, team.id, "member");

        const res = await create("Homelab");
        expect(res.status).toBe(201);
    });

    it("should ignore a soft-deleted free org", async () => {
        const db = getTestDb();
        const org = await createOrganization(db, { slug: "old-free-org", plan: "free" });
        await addOrgMember(db, user.id, org.id, "owner");
        await db.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, org.id));

        const res = await create("Fresh Start");
        expect(res.status).toBe(201);
    });

    it("should allow a new org once the existing free org is upgraded", async () => {
        const db = getTestDb();
        const org = await createOrganization(db, { slug: "free-org", plan: "free" });
        await addOrgMember(db, user.id, org.id, "owner");

        expect((await create("Second Org")).status).toBe(409);

        await db.update(organizations).set({ plan: "pro" }).where(eq(organizations.id, org.id));

        expect((await create("Second Org")).status).toBe(201);
    });
});
