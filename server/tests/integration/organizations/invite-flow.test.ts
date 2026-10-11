import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createUser, createOrganization, addOrgMember, createOrgInvite } from "../../fixtures/seed-data.js";
import type { Organization, User } from "../../../src/db/schema/index.js";

import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("Invite management (/api/organizations/:id/invites)", () => {
    let app: Express;
    let owner: User;
    let org: Organization;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        owner = await createUser(db, { email: "owner@test.com" });
        org = await createOrganization(db, { slug: "pro-org", plan: "pro" });
        await addOrgMember(db, owner.id, org.id, "owner");
    });

    function headersFor(user: User) {
        return createInternalHeaders({
            id: user.id,
            email: user.email,
            orgId: org.id,
            orgName: org.name,
            orgSlug: org.slug,
            orgPlan: org.plan,
        });
    }

    describe("POST /invites (create)", () => {
        it("should create an invite and return a shareable invite URL", async () => {
            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headersFor(owner))
                .send({ email: "Newcomer@Test.com", role: "member" });

            expect(res.status).toBe(201);
            expect(res.body.invite.email).toBe("newcomer@test.com");
            expect(res.body.invite.role).toBe("member");
            expect(res.body.invite.inviteUrl).toMatch(/\/invite\/[a-f0-9]{64}$/);
        });

        it("should reject creation by a non-admin member", async () => {
            const db = getTestDb();
            const member = await createUser(db, { email: "member@test.com" });
            await addOrgMember(db, member.id, org.id, "member");

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headersFor(member))
                .send({ email: "newcomer@test.com", role: "member" });

            expect(res.status).toBe(403);
        });

        it("should reject a duplicate active invite for the same email", async () => {
            await createOrgInvite(getTestDb(), org.id, owner.id, { email: "newcomer@test.com" });

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headersFor(owner))
                .send({ email: "newcomer@test.com", role: "member" });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/already exists/i);
        });

        it("should allow a new invite when the previous one has expired", async () => {
            await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "newcomer@test.com",
                expiresAt: new Date(Date.now() - 1000),
            });

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headersFor(owner))
                .send({ email: "newcomer@test.com", role: "member" });

            expect(res.status).toBe(201);
        });

        it("should reject inviting an existing member (case-insensitive)", async () => {
            const db = getTestDb();
            const member = await createUser(db, { email: "existing@test.com" });
            await addOrgMember(db, member.id, org.id, "member");

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headersFor(owner))
                .send({ email: "Existing@Test.com", role: "member" });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/already a member/i);
        });

        itCloud("should count pending invites toward the member limit", async () => {
            const db = getTestDb();
            // Pro plan allows 10 members. Fill to 5 members + 5 pending invites.
            for (let i = 0; i < 4; i++) {
                const u = await createUser(db, { email: `member-${i}@test.com` });
                await addOrgMember(db, u.id, org.id, "member");
            }
            for (let i = 0; i < 5; i++) {
                await createOrgInvite(db, org.id, owner.id, { email: `pending-${i}@test.com` });
            }

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headersFor(owner))
                .send({ email: "one-too-many@test.com", role: "member" });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/maximum of 10 member/i);
            expect(res.body.error).toMatch(/pending invites/i);
        });
    });

    describe("GET /invites (list)", () => {
        it("should list pending invites with invite URLs", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "pending@test.com",
                role: "admin",
            });

            const res = await request(app).get(`/api/organizations/${org.id}/invites`).set(headersFor(owner));

            expect(res.status).toBe(200);
            expect(res.body.invites).toHaveLength(1);
            expect(res.body.invites[0].email).toBe("pending@test.com");
            expect(res.body.invites[0].role).toBe("admin");
            expect(res.body.invites[0].inviteUrl).toContain(`/invite/${invite.token}`);
            expect(res.body.invites[0].invitedBy.id).toBe(owner.id);
        });

        it("should not list expired invites", async () => {
            await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "expired@test.com",
                expiresAt: new Date(Date.now() - 1000),
            });

            const res = await request(app).get(`/api/organizations/${org.id}/invites`).set(headersFor(owner));

            expect(res.status).toBe(200);
            expect(res.body.invites).toHaveLength(0);
        });

        it("should reject listing by a non-admin member", async () => {
            const db = getTestDb();
            const member = await createUser(db, { email: "member@test.com" });
            await addOrgMember(db, member.id, org.id, "member");

            const res = await request(app).get(`/api/organizations/${org.id}/invites`).set(headersFor(member));

            expect(res.status).toBe(403);
        });
    });

    describe("DELETE /invites/:inviteId (cancel)", () => {
        it("should cancel an invite", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "pending@test.com",
            });

            const res = await request(app)
                .delete(`/api/organizations/${org.id}/invites/${invite.id}`)
                .set(headersFor(owner));

            expect(res.status).toBe(200);

            const list = await request(app).get(`/api/organizations/${org.id}/invites`).set(headersFor(owner));
            expect(list.body.invites).toHaveLength(0);
        });

        it("should not cancel an invite belonging to another organization", async () => {
            const db = getTestDb();
            const otherOrg = await createOrganization(db, { slug: "other-org", plan: "pro" });
            const otherOwner = await createUser(db, { email: "other-owner@test.com" });
            await addOrgMember(db, otherOwner.id, otherOrg.id, "owner");
            const foreignInvite = await createOrgInvite(db, otherOrg.id, otherOwner.id, {
                email: "foreign@test.com",
            });

            const res = await request(app)
                .delete(`/api/organizations/${org.id}/invites/${foreignInvite.id}`)
                .set(headersFor(owner));

            expect(res.status).toBe(404);
        });
    });
});
