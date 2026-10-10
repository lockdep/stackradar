import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createUser,
    createOrganization,
    addOrgMember,
    createOrgInvite,
} from "../../fixtures/seed-data.js";
import { termsAcceptances, orgTermsAcceptances } from "../../../src/db/schema/index.js";
import type { User } from "../../../src/db/schema/index.js";
import { CURRENT_TERMS_VERSION } from "../../../src/cloud/terms/version.js";

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Terms acceptance", () => {
    let app: Express;
    let user: User;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        user = await createUser(getTestDb(), { email: "user@test.com" });
    });

    function userHeaders(u: User) {
        return createInternalHeaders({ id: u.id, email: u.email });
    }

    async function getAcceptances(userId: string) {
        return getTestDb()
            .select()
            .from(termsAcceptances)
            .where(eq(termsAcceptances.userId, userId));
    }

    async function getOrgAcceptances(orgId: string) {
        return getTestDb()
            .select()
            .from(orgTermsAcceptances)
            .where(eq(orgTermsAcceptances.orgId, orgId));
    }

    describe("GET /api/users/terms", () => {
        it("should require authentication", async () => {
            const res = await request(app).get("/api/users/terms");
            expect(res.status).toBe(401);
        });

        it("should report not accepted for a user with no acceptance record", async () => {
            const res = await request(app).get("/api/users/terms").set(userHeaders(user));

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                requiredVersion: CURRENT_TERMS_VERSION,
                acceptedVersion: null,
                accepted: false,
            });
        });

        it("should report not accepted when only an older version was accepted", async () => {
            await getTestDb()
                .insert(termsAcceptances)
                .values({ userId: user.id, termsVersion: "2020-01-01" });

            const res = await request(app).get("/api/users/terms").set(userHeaders(user));

            expect(res.status).toBe(200);
            expect(res.body.acceptedVersion).toBe("2020-01-01");
            expect(res.body.accepted).toBe(false);
        });
    });

    describe("POST /api/users/terms/accept", () => {
        it("should record acceptance of the current version", async () => {
            const res = await request(app)
                .post("/api/users/terms/accept")
                .set(userHeaders(user));

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                accepted: true,
                acceptedVersion: CURRENT_TERMS_VERSION,
            });

            const rows = await getAcceptances(user.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.termsVersion).toBe(CURRENT_TERMS_VERSION);

            const status = await request(app).get("/api/users/terms").set(userHeaders(user));
            expect(status.body.accepted).toBe(true);
        });

        it("should be idempotent and keep the first acceptance timestamp", async () => {
            await request(app).post("/api/users/terms/accept").set(userHeaders(user));
            const [first] = await getAcceptances(user.id);

            const again = await request(app)
                .post("/api/users/terms/accept")
                .set(userHeaders(user));
            expect(again.status).toBe(200);

            const rows = await getAcceptances(user.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.acceptedAt).toEqual(first!.acceptedAt);
        });

        it("should keep older acceptances as history when a new version is accepted", async () => {
            await getTestDb()
                .insert(termsAcceptances)
                .values({ userId: user.id, termsVersion: "2020-01-01" });

            await request(app).post("/api/users/terms/accept").set(userHeaders(user));

            const rows = await getAcceptances(user.id);
            expect(rows.map((r) => r.termsVersion).sort()).toEqual(
                ["2020-01-01", CURRENT_TERMS_VERSION].sort()
            );
        });
    });

    describe("acceptance recorded at the org entry points", () => {
        it("should record user and org acceptance on first-time user setup", async () => {
            const res = await request(app)
                .post("/api/users/setup")
                .set(userHeaders(user))
                .send({ userId: user.id, userName: "Test User", userEmail: user.email });

            expect(res.status).toBe(201);

            const rows = await getAcceptances(user.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.termsVersion).toBe(CURRENT_TERMS_VERSION);

            const orgRows = await getOrgAcceptances(res.body.organization.id);
            expect(orgRows).toHaveLength(1);
            expect(orgRows[0]!.acceptedByUserId).toBe(user.id);
            expect(orgRows[0]!.acceptedByRole).toBe("owner");
            expect(orgRows[0]!.termsVersion).toBe(CURRENT_TERMS_VERSION);
        });

        it("should record org acceptance when an additional organization is created", async () => {
            const res = await request(app)
                .post("/api/users/organizations")
                .set(userHeaders(user))
                .send({ name: "Second Org" });

            expect(res.status).toBe(201);

            const orgRows = await getOrgAcceptances(res.body.organization.id);
            expect(orgRows).toHaveLength(1);
            expect(orgRows[0]!.acceptedByRole).toBe("owner");
        });

        it("should record user and org acceptance when an invite is accepted", async () => {
            const db = getTestDb();
            const owner = await createUser(db, { email: "owner@test.com" });
            const org = await createOrganization(db, { slug: "pro-org", plan: "pro" });
            await addOrgMember(db, owner.id, org.id, "owner");
            const invite = await createOrgInvite(db, org.id, owner.id, {
                email: user.email,
                role: "member",
            });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(user));

            expect(res.status).toBe(200);

            const rows = await getAcceptances(user.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.termsVersion).toBe(CURRENT_TERMS_VERSION);

            // The org had no acceptance row (seeded directly), so the joining
            // member's acceptance binds it, role frozen at acceptance time.
            const orgRows = await getOrgAcceptances(org.id);
            expect(orgRows).toHaveLength(1);
            expect(orgRows[0]!.acceptedByUserId).toBe(user.id);
            expect(orgRows[0]!.acceptedByRole).toBe("member");
        });

        it("should not record acceptance when invite acceptance fails at the member limit", async () => {
            // Free plan allows 1 member; the owner occupies the seat, so the
            // transaction rolls back — the acceptance rows must roll back too.
            const db = getTestDb();
            const owner = await createUser(db, { email: "owner@test.com" });
            const freeOrg = await createOrganization(db, { slug: "free-org", plan: "free" });
            await addOrgMember(db, owner.id, freeOrg.id, "owner");
            const invite = await createOrgInvite(db, freeOrg.id, owner.id, { email: user.email });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(userHeaders(user));

            expect(res.status).toBe(403);
            expect(await getAcceptances(user.id)).toHaveLength(0);
            expect(await getOrgAcceptances(freeOrg.id)).toHaveLength(0);
        });

        it("should bind all of a user's orgs on explicit acceptance, keeping an existing org binding", async () => {
            const db = getTestDb();
            const orgA = await createOrganization(db, { slug: "org-a", plan: "pro" });
            const orgB = await createOrganization(db, { slug: "org-b", plan: "pro" });
            await addOrgMember(db, user.id, orgA.id, "admin");
            await addOrgMember(db, user.id, orgB.id, "member");

            // orgA is already bound to the current version by someone else —
            // that first acceptance must survive.
            const other = await createUser(db, { email: "other@test.com" });
            await addOrgMember(db, other.id, orgA.id, "owner");
            await db.insert(orgTermsAcceptances).values({
                orgId: orgA.id,
                acceptedByUserId: other.id,
                acceptedByRole: "owner",
                termsVersion: CURRENT_TERMS_VERSION,
            });

            const res = await request(app)
                .post("/api/users/terms/accept")
                .set(userHeaders(user));
            expect(res.status).toBe(200);

            const orgARows = await getOrgAcceptances(orgA.id);
            expect(orgARows).toHaveLength(1);
            expect(orgARows[0]!.acceptedByUserId).toBe(other.id);

            const orgBRows = await getOrgAcceptances(orgB.id);
            expect(orgBRows).toHaveLength(1);
            expect(orgBRows[0]!.acceptedByUserId).toBe(user.id);
            expect(orgBRows[0]!.acceptedByRole).toBe("member");
        });
    });
});
