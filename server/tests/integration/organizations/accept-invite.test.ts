import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createUser,
    createOrganization,
    addOrgMember,
    createOrgInvite,
} from "../../fixtures/seed-data.js";
import { orgMembers, orgInvites, users } from "../../../src/db/schema/index.js";
import type { Organization, User } from "../../../src/db/schema/index.js";

import { edition } from "../../../src/edition.js";
// Plan limits and history windows are the cloud's: the community edition has one plan with no caps
// and one window, so these cases skip under `STACKRADAR_EDITION=community`.
const itCloud = it.skipIf(!edition.isCloud);

describe("Invite acceptance (/api/invites/:token)", () => {
    let app: Express;
    let owner: User;
    let invitee: User;
    let org: Organization;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        owner = await createUser(db, { email: "owner@test.com" });
        invitee = await createUser(db, { email: "invitee@test.com" });
        org = await createOrganization(db, { slug: "pro-org", plan: "pro", name: "Pro Org" });
        await addOrgMember(db, owner.id, org.id, "owner");
    });

    function userHeaders(user: User) {
        return createInternalHeaders({ id: user.id, email: user.email });
    }

    async function getMembership(userId: string) {
        const [row] = await getTestDb()
            .select()
            .from(orgMembers)
            .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, userId)));
        return row;
    }

    describe("GET /:token (public invite details)", () => {
        it("should return invite details without authentication", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
                role: "admin",
            });

            const res = await request(app).get(`/api/invites/${invite.token}`);

            expect(res.status).toBe(200);
            expect(res.body.invite.email).toBe(invitee.email);
            expect(res.body.invite.role).toBe("admin");
            expect(res.body.invite.organization.name).toBe("Pro Org");
        });

        it("should return 404 for an unknown token", async () => {
            const res = await request(app).get(`/api/invites/${"0".repeat(64)}`);
            expect(res.status).toBe(404);
        });

        it("should return 404 for an expired invite", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
                expiresAt: new Date(Date.now() - 1000),
            });

            const res = await request(app).get(`/api/invites/${invite.token}`);
            expect(res.status).toBe(404);
        });
    });

    describe("POST /:token/accept", () => {
        it("should require authentication", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
            });

            const res = await request(app).post(`/api/invites/${invite.token}/accept`);
            expect(res.status).toBe(401);
        });

        it("should add the user as a member with the invited role and consume the invite", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
                role: "admin",
            });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(invitee));

            expect(res.status).toBe(200);
            expect(res.body.organization.id).toBe(org.id);
            expect(res.body.organization.slug).toBe(org.slug);

            const membership = await getMembership(invitee.id);
            expect(membership?.role).toBe("admin");

            // Invite is consumed — accepting again fails
            const again = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(invitee));
            expect(again.status).toBe(404);
        });

        it("should accept when the email matches with different casing", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
            });
            const headers = createInternalHeaders({ id: invitee.id, email: "Invitee@Test.COM" });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(headers);

            expect(res.status).toBe(200);
            expect(await getMembership(invitee.id)).toBeDefined();
        });

        it("should let a brand-new user (no users row yet) join via the link without getting a personal org", async () => {
            // Sign-up-through-invite: the account was just created by OAuth and
            // has never been through /users/setup, so the users row does not
            // exist. Accepting must create it, add the membership, and leave
            // the user with exactly the invited org.
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "fresh@test.com",
            });
            const freshId = "11111111-2222-4333-8444-555555555555";
            const headers = createInternalHeaders({ id: freshId, email: "fresh@test.com", name: "Fresh Person" });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(headers);

            expect(res.status).toBe(200);
            expect(res.body.organization.id).toBe(org.id);

            const [userRow] = await getTestDb().select().from(users).where(eq(users.id, freshId));
            expect(userRow).toMatchObject({ email: "fresh@test.com", name: "Fresh Person" });

            const memberships = await getTestDb().select().from(orgMembers).where(eq(orgMembers.userId, freshId));
            expect(memberships).toHaveLength(1);
            expect(memberships[0]!.orgId).toBe(org.id);

            // /users/setup afterwards must not create a second org either
            const setup = await request(app)
                .post("/api/users/setup")
                .set(headers)
                .send({ userId: freshId, userEmail: "fresh@test.com", userName: "Fresh Person" });
            expect(setup.status).toBe(200);
            expect(setup.body.organization.id).toBe(org.id);
        });

        it("should invalidate the link after one use — a second user cannot reuse it", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "first@test.com",
            });
            const first = await createUser(getTestDb(), { email: "first@test.com" });
            const second = await createUser(getTestDb(), { email: "second@test.com" });

            const ok = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(first));
            expect(ok.status).toBe(200);

            const reuse = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(second));
            expect(reuse.status).toBe(404);
            expect(await getMembership(second.id)).toBeUndefined();

            const [row] = await getTestDb().select().from(orgInvites).where(eq(orgInvites.id, invite.id));
            expect(row).toBeUndefined();
        });

        it("should accept from an account with a different email than the invite was sent to", async () => {
            // The token is the capability: an admin invites a work address,
            // but the invitee's GitHub account may carry a personal one.
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: "work-address@test.com",
            });
            const personal = await createUser(getTestDb(), { email: "personal@test.com" });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(personal));

            expect(res.status).toBe(200);
            expect(await getMembership(personal.id)).toBeDefined();
        });
        it("should reject an expired invite", async () => {
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
                expiresAt: new Date(Date.now() - 1000),
            });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(invitee));

            expect(res.status).toBe(404);
        });

        it("should reject and consume the invite if the user is already a member", async () => {
            await addOrgMember(getTestDb(), invitee.id, org.id, "member");
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, {
                email: invitee.email,
            });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(invitee));

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/already a member/i);

            const [remaining] = await getTestDb()
                .select()
                .from(orgInvites)
                .where(eq(orgInvites.id, invite.id));
            expect(remaining).toBeUndefined();
        });

        itCloud("should enforce the member limit at acceptance time and keep the invite", async () => {
            // Free plan allows 1 member; the owner already occupies the seat.
            // The invite is seeded directly, simulating an invite created
            // before the org filled up (or before a downgrade).
            const db = getTestDb();
            const freeOrg = await createOrganization(db, { slug: "free-org", plan: "free" });
            await addOrgMember(db, owner.id, freeOrg.id, "owner");
            const invite = await createOrgInvite(db, freeOrg.id, owner.id, {
                email: invitee.email,
            });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(invitee));

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/member limit/i);

            // Member was not added and the invite survives the rolled-back
            // transaction, so it can be accepted after an upgrade.
            const [membership] = await db
                .select()
                .from(orgMembers)
                .where(and(eq(orgMembers.orgId, freeOrg.id), eq(orgMembers.userId, invitee.id)));
            expect(membership).toBeUndefined();

            const [remaining] = await db
                .select()
                .from(orgInvites)
                .where(eq(orgInvites.id, invite.id));
            expect(remaining).toBeDefined();
        });
    });
});
