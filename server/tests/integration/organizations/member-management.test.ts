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
} from "../../fixtures/seed-data.js";
import { orgMembers } from "../../../src/db/schema/index.js";
import type { Organization, User } from "../../../src/db/schema/index.js";

describe("Member management (/api/organizations/:id/members)", () => {
    let app: Express;
    let owner: User;
    let admin: User;
    let member: User;
    let org: Organization;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        owner = await createUser(db, { email: "owner@test.com" });
        admin = await createUser(db, { email: "admin@test.com" });
        member = await createUser(db, { email: "member@test.com" });
        org = await createOrganization(db, { slug: "team-org", plan: "team" });
        await addOrgMember(db, owner.id, org.id, "owner");
        await addOrgMember(db, admin.id, org.id, "admin");
        await addOrgMember(db, member.id, org.id, "member");
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

    async function getRole(userId: string): Promise<string | undefined> {
        const [row] = await getTestDb()
            .select({ role: orgMembers.role })
            .from(orgMembers)
            .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, userId)));
        return row?.role;
    }

    describe("GET /members", () => {
        it("should list all members with their roles for any member", async () => {
            const res = await request(app)
                .get(`/api/organizations/${org.id}/members`)
                .set(headersFor(member));

            expect(res.status).toBe(200);
            expect(res.body.members).toHaveLength(3);
            const roles = Object.fromEntries(
                res.body.members.map((m: { email: string; role: string }) => [m.email, m.role])
            );
            expect(roles["owner@test.com"]).toBe("owner");
            expect(roles["admin@test.com"]).toBe("admin");
            expect(roles["member@test.com"]).toBe("member");
        });

        it("should reject a non-member", async () => {
            const outsider = await createUser(getTestDb(), { email: "outsider@test.com" });

            const res = await request(app)
                .get(`/api/organizations/${org.id}/members`)
                .set(headersFor(outsider));

            expect(res.status).toBe(403);
        });
    });

    describe("PATCH /members/:userId (role changes)", () => {
        it("should let the owner promote a member to admin", async () => {
            const res = await request(app)
                .patch(`/api/organizations/${org.id}/members/${member.id}`)
                .set(headersFor(owner))
                .send({ role: "admin" });

            expect(res.status).toBe(200);
            expect(await getRole(member.id)).toBe("admin");
        });

        it("should not let an admin promote a member to admin", async () => {
            const res = await request(app)
                .patch(`/api/organizations/${org.id}/members/${member.id}`)
                .set(headersFor(admin))
                .send({ role: "admin" });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/only owner/i);
            expect(await getRole(member.id)).toBe("member");
        });

        it("should let an admin demote another admin to member", async () => {
            const db = getTestDb();
            const secondAdmin = await createUser(db, { email: "admin2@test.com" });
            await addOrgMember(db, secondAdmin.id, org.id, "admin");

            const res = await request(app)
                .patch(`/api/organizations/${org.id}/members/${secondAdmin.id}`)
                .set(headersFor(admin))
                .send({ role: "member" });

            expect(res.status).toBe(200);
            expect(await getRole(secondAdmin.id)).toBe("member");
        });

        it("should not allow changing the owner's role", async () => {
            const res = await request(app)
                .patch(`/api/organizations/${org.id}/members/${owner.id}`)
                .set(headersFor(admin))
                .send({ role: "member" });

            expect(res.status).toBe(403);
            expect(await getRole(owner.id)).toBe("owner");
        });

        it("should not let a regular member change roles", async () => {
            const res = await request(app)
                .patch(`/api/organizations/${org.id}/members/${admin.id}`)
                .set(headersFor(member))
                .send({ role: "member" });

            expect(res.status).toBe(403);
        });

        it("should 404 for a user who is not a member", async () => {
            const outsider = await createUser(getTestDb(), { email: "outsider@test.com" });

            const res = await request(app)
                .patch(`/api/organizations/${org.id}/members/${outsider.id}`)
                .set(headersFor(owner))
                .send({ role: "admin" });

            expect(res.status).toBe(404);
        });
    });

    describe("DELETE /members/:userId (remove)", () => {
        it("should let an admin remove a member", async () => {
            const res = await request(app)
                .delete(`/api/organizations/${org.id}/members/${member.id}`)
                .set(headersFor(admin));

            expect(res.status).toBe(200);
            expect(await getRole(member.id)).toBeUndefined();
        });

        it("should not allow removing the owner", async () => {
            const res = await request(app)
                .delete(`/api/organizations/${org.id}/members/${owner.id}`)
                .set(headersFor(admin));

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/cannot be removed/i);
            expect(await getRole(owner.id)).toBe("owner");
        });

        it("should not let a regular member remove anyone", async () => {
            const res = await request(app)
                .delete(`/api/organizations/${org.id}/members/${admin.id}`)
                .set(headersFor(member));

            expect(res.status).toBe(403);
            expect(await getRole(admin.id)).toBe("admin");
        });
    });

    describe("POST /leave", () => {
        it("should let a member leave the organization", async () => {
            const res = await request(app)
                .post(`/api/organizations/${org.id}/leave`)
                .set(headersFor(member));

            expect(res.status).toBe(200);
            expect(await getRole(member.id)).toBeUndefined();
        });

        it("should not let the owner leave", async () => {
            const res = await request(app)
                .post(`/api/organizations/${org.id}/leave`)
                .set(headersFor(owner));

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/cannot leave/i);
            expect(await getRole(owner.id)).toBe("owner");
        });
    });
});
