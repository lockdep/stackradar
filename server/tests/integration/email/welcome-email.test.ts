import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, createOrgInvite, createUser } from "../../fixtures/seed-data.js";

process.env.RESEND_API_KEY = "re_test_key";
process.env.APP_URL = "https://app.test";
process.env.SITE_URL = "https://site.test";

const fetchMock = vi.fn();

function sentEmails() {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body) as { to: string[]; subject: string; text: string; tags: Array<{ name: string; value: string }> });
}

describe("Welcome email", () => {
    let app: Express;

    beforeAll(async () => {
        vi.stubGlobal("fetch", fetchMock);
        app = await getTestApp();
    });
    afterAll(() => vi.unstubAllGlobals());

    beforeEach(async () => {
        await cleanAllData();
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: "msg_w" }), { status: 200 }));
    });

    describe("POST /api/users/setup (self sign-up)", () => {
        const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        // Since S6 the body is ignored entirely — identity comes from the
        // BFF-verified session headers. The body stays here to prove it.
        const body = { userId: "11111111-2222-4333-8444-555555555555", userEmail: "attacker@evil.test", userName: "Mallory" };

        it("sends the new_org welcome once, on first setup only", async () => {
            const headers = createInternalHeaders({ id: userId, email: "New@Test.com", name: "Newcomer" });

            const first = await request(app).post("/api/users/setup").set(headers).send(body);
            expect(first.status).toBe(201);

            const emails = sentEmails();
            expect(emails).toHaveLength(1);
            expect(emails[0]!.to).toEqual(["new@test.com"]);
            expect(emails[0]!.subject).toBe("Welcome to StackRadar — connect your first cluster");
            expect(emails[0]!.text).toContain("Hi Newcomer,");
            expect(emails[0]!.text).toContain("Newcomer's Organization");
            expect(emails[0]!.text).toContain("https://site.test/docs/quick-start");
            expect(emails[0]!.tags).toContainEqual({ name: "variant", value: "new_org" });
            expect(fetchMock.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(`welcome/${userId}`);

            // Second setup call (e.g. page reload) — user exists, no email
            const second = await request(app).post("/api/users/setup").set(headers).send(body);
            expect(second.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("does not email an existing user who already has an org", async () => {
            const { user } = await createOrgWithOwner(getTestDb(), { email: "old@test.com" });
            const res = await request(app)
                .post("/api/users/setup")
                .set(createInternalHeaders({ id: user.id, email: user.email }))
                .send({ userId: user.id, userEmail: user.email, userName: user.name });
            expect(res.status).toBe(200);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("still completes setup when the send fails", async () => {
            fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
            const res = await request(app)
                .post("/api/users/setup")
                .set(createInternalHeaders({ id: userId, email: body.userEmail }))
                .send(body);
            expect(res.status).toBe(201);
            expect(res.body.organization).toBeDefined();
        });
    });

    describe("POST /api/invites/:token/accept (sign-up through invite)", () => {
        it("sends the joined_org welcome to a brand-new user", async () => {
            const { user: owner, org } = await createOrgWithOwner(getTestDb(), {}, { name: "Acme Corp", plan: "pro" });
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, { email: "fresh@test.com", role: "admin" });
            const freshId = "11111111-2222-4333-8444-555555555555";

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(createInternalHeaders({ id: freshId, email: "fresh@test.com", name: "Fresh" }));
            expect(res.status).toBe(200);

            const emails = sentEmails();
            expect(emails).toHaveLength(1);
            expect(emails[0]!.to).toEqual(["fresh@test.com"]);
            expect(emails[0]!.subject).toBe("Welcome to StackRadar — you've joined Acme Corp");
            expect(emails[0]!.text).toContain("as an admin");
            expect(emails[0]!.tags).toContainEqual({ name: "variant", value: "joined_org" });
        });

        it("does not email an existing user who accepts an invite", async () => {
            const { user: owner, org } = await createOrgWithOwner(getTestDb(), {}, { plan: "pro" });
            const existing = await createUser(getTestDb(), { email: "existing@test.com" });
            const invite = await createOrgInvite(getTestDb(), org.id, owner.id, { email: existing.email });

            const res = await request(app)
                .post(`/api/invites/${invite.token}/accept`)
                .set(createInternalHeaders({ id: existing.id, email: existing.email }));
            expect(res.status).toBe(200);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });
});
