import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createUser,
    createOrganization,
    addOrgMember,
} from "../../fixtures/seed-data.js";
import type { Organization, User } from "../../../src/db/schema/index.js";

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Member limit enforcement (POST /api/organizations/:id/invites)", () => {
    let app: Express;
    let owner: User;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        owner = await createUser(getTestDb(), { email: "owner@test.com" });
    });

    function inviteHeaders(org: Organization) {
        return createInternalHeaders({
            id: owner.id,
            email: owner.email,
            orgId: org.id,
            orgName: org.name,
            orgSlug: org.slug,
            orgPlan: org.plan,
        });
    }

    describe("Free plan (limit: 1 member)", () => {
        it("should reject an invite when the org already has 1 member (the owner)", async () => {
            const db = getTestDb();
            const org = await createOrganization(db, { slug: "free-org", plan: "free" });
            await addOrgMember(db, owner.id, org.id, "owner");

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(inviteHeaders(org))
                .send({ email: "newcomer@test.com", role: "member" });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/maximum of 1 member/i);
            expect(res.body.error).toMatch(/upgrade your plan/i);
        });
    });

    describe("Pro plan (limit: 10 members)", () => {
        it("should allow inviting a member", async () => {
            const db = getTestDb();
            const org = await createOrganization(db, { slug: "pro-org", plan: "pro" });
            await addOrgMember(db, owner.id, org.id, "owner");

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(inviteHeaders(org))
                .send({ email: "newcomer@test.com", role: "member" });

            expect(res.status).toBe(201);
            expect(res.body.invite.email).toBe("newcomer@test.com");
        });

        it("should allow inviting multiple members", async () => {
            const db = getTestDb();
            const org = await createOrganization(db, { slug: "pro-org-2", plan: "pro" });
            await addOrgMember(db, owner.id, org.id, "owner");

            // Add a second member directly
            const second = await createUser(db, { email: "second@test.com" });
            await addOrgMember(db, second.id, org.id, "member");

            // Should still be able to invite a third
            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(inviteHeaders(org))
                .send({ email: "third@test.com", role: "member" });

            expect(res.status).toBe(201);
        });
    });
});
