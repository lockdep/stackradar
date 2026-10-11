import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createUser, createOrganization, addOrgMember } from "../../fixtures/seed-data.js";
import { feedback } from "../../../src/db/schema/index.js";
import type { User, Organization } from "../../../src/db/schema/index.js";

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Feedback", () => {
    let app: Express;
    let user: User;
    let org: Organization;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        user = await createUser(getTestDb(), { email: "user@test.com", name: "Feedback User" });
        org = await createOrganization(getTestDb());
        await addOrgMember(getTestDb(), user.id, org.id);
    });

    function userHeaders(u: User, opts: { orgId?: string; isAdmin?: boolean } = {}) {
        return createInternalHeaders({ id: u.id, email: u.email, ...opts });
    }

    describe("POST /api/feedback", () => {
        it("should require authentication", async () => {
            const res = await request(app).post("/api/feedback").send({ message: "hi" });
            expect(res.status).toBe(401);
        });

        it("should store the message linked to the user and active org", async () => {
            const res = await request(app)
                .post("/api/feedback")
                .set(userHeaders(user, { orgId: org.id }))
                .send({ message: "The clusters page is great", page: "/clusters" });

            expect(res.status).toBe(201);
            expect(res.body.id).toBeDefined();

            const rows = await getTestDb().select().from(feedback).where(eq(feedback.userId, user.id));
            expect(rows).toHaveLength(1);
            expect(rows[0]!.message).toBe("The clusters page is great");
            expect(rows[0]!.page).toBe("/clusters");
            expect(rows[0]!.orgId).toBe(org.id);
        });

        it("should reject an empty message", async () => {
            const res = await request(app).post("/api/feedback").set(userHeaders(user)).send({ message: "   " });

            expect(res.status).toBe(400);
        });
    });

    describe("GET /api/admin/feedback", () => {
        it("should refuse non-admin users", async () => {
            const res = await request(app).get("/api/admin/feedback").set(userHeaders(user));
            expect(res.status).toBe(403);
        });

        it("should list feedback newest first with the author joined on", async () => {
            const other = await createUser(getTestDb(), { email: "other@test.com", name: "Other User" });
            await getTestDb()
                .insert(feedback)
                .values([
                    { userId: user.id, orgId: org.id, message: "first", createdAt: new Date("2026-01-01T00:00:00Z") },
                    { userId: other.id, message: "second", page: "/fix", createdAt: new Date("2026-02-01T00:00:00Z") },
                ]);

            const res = await request(app)
                .get("/api/admin/feedback")
                .set(userHeaders(user, { isAdmin: true }));

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(2);
            expect(res.body.feedback).toHaveLength(2);

            const [newest, oldest] = res.body.feedback;
            expect(newest.message).toBe("second");
            expect(newest.userEmail).toBe("other@test.com");
            expect(newest.page).toBe("/fix");
            expect(newest.orgName).toBeNull();
            expect(oldest.message).toBe("first");
            expect(oldest.userName).toBe("Feedback User");
            expect(oldest.orgName).toBe(org.name);
        });

        it("should page with limit and offset", async () => {
            await getTestDb()
                .insert(feedback)
                .values([
                    { userId: user.id, message: "a", createdAt: new Date("2026-01-01T00:00:00Z") },
                    { userId: user.id, message: "b", createdAt: new Date("2026-01-02T00:00:00Z") },
                    { userId: user.id, message: "c", createdAt: new Date("2026-01-03T00:00:00Z") },
                ]);

            const res = await request(app)
                .get("/api/admin/feedback?limit=1&offset=1")
                .set(userHeaders(user, { isAdmin: true }));

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(3);
            expect(res.body.feedback).toHaveLength(1);
            expect(res.body.feedback[0].message).toBe("b");
        });
    });
});
