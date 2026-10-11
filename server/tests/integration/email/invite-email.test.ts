import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, createOrgInvite } from "../../fixtures/seed-data.js";
import { orgInvites } from "../../../src/db/schema/index.js";
import { signResendPayload } from "../../../src/cloud/email/resend-webhook.js";

// `vi.hoisted` runs before the imports below are evaluated. That matters
// because `config` snapshots `process.env` once at import and the fixtures
// (`seed-data` → `api-key-vault`) pull it in transitively, so a plain
// top-level assignment would land after the snapshot and be ignored.
// Module isolation means none of this leaks into other test files.
const { WEBHOOK_SECRET } = vi.hoisted(() => {
    const WEBHOOK_SECRET = "whsec_" + Buffer.from("test-webhook-secret").toString("base64");
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.APP_URL = "https://app.test";
    return { WEBHOOK_SECRET };
});

const fetchMock = vi.fn();

async function getInvite(id: string) {
    const [row] = await getTestDb().select().from(orgInvites).where(eq(orgInvites.id, id));
    return row!;
}

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Invite email", () => {
    let app: Express;

    beforeAll(async () => {
        vi.stubGlobal("fetch", fetchMock);
        app = await getTestApp();
    });

    afterAll(() => vi.unstubAllGlobals());

    beforeEach(async () => {
        await cleanAllData();
        fetchMock.mockReset();
    });

    async function seed() {
        const { user, org } = await createOrgWithOwner(
            getTestDb(),
            { email: "owner@test.com", name: "Olivia Owner" },
            { name: "Acme Corp", plan: "pro" },
        );
        const headers = createInternalHeaders({
            id: user.id,
            email: user.email,
            name: user.name ?? "Owner",
            orgId: org.id,
            orgName: org.name,
            orgSlug: org.slug,
            orgPlan: org.plan,
        });
        return { user, org, headers };
    }

    describe("POST /api/organizations/:id/invites", () => {
        it("sends the invite email via Resend and records the message id", async () => {
            const { org, headers } = await seed();
            fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "msg_abc" }), { status: 200 }));

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headers)
                .send({ email: "new@test.com", role: "admin" });

            expect(res.status).toBe(201);
            expect(res.body.invite.emailStatus).toBe("sent");

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0]!;
            expect(url).toBe("https://api.resend.com/emails");
            expect(init.headers.Authorization).toBe("Bearer re_test_key");
            expect(init.headers["Idempotency-Key"]).toBe(`org-invite/${res.body.invite.id}`);
            const body = JSON.parse(init.body);
            expect(body.to).toEqual(["new@test.com"]);
            expect(body.subject).toBe("Olivia Owner invited you to join Acme Corp on StackRadar");
            expect(body.html).toContain(res.body.invite.inviteUrl);
            expect(body.text).toContain("as an admin");
            expect(body.tags).toContainEqual({ name: "org_id", value: org.id });

            const row = await getInvite(res.body.invite.id);
            expect(row.emailStatus).toBe("sent");
            expect(row.emailMessageId).toBe("msg_abc");
            expect(row.emailStatusAt).toBeInstanceOf(Date);
        });

        it("still creates the invite (201 with inviteUrl) when Resend rejects the send", async () => {
            const { org, headers } = await seed();
            fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

            const res = await request(app)
                .post(`/api/organizations/${org.id}/invites`)
                .set(headers)
                .send({ email: "new@test.com", role: "member" });

            expect(res.status).toBe(201);
            expect(res.body.invite.emailStatus).toBe("failed");
            expect(res.body.invite.inviteUrl).toMatch(/\/invite\/[a-f0-9]{64}$/);

            const row = await getInvite(res.body.invite.id);
            expect(row.emailStatus).toBe("failed");
            expect(row.emailMessageId).toBeNull();
        });
    });

    describe("POST /v1/webhooks/resend", () => {
        function send(event: object, opts: { secret?: string; timestamp?: string; id?: string } = {}) {
            const body = JSON.stringify(event);
            const id = opts.id ?? "msg_evt_1";
            const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
            const sig = signResendPayload(opts.secret ?? WEBHOOK_SECRET, id, timestamp, body);
            return request(app)
                .post("/v1/webhooks/resend")
                .set("svix-id", id)
                .set("svix-timestamp", timestamp)
                .set("svix-signature", `v1,${sig}`)
                .set("content-type", "application/json")
                .send(body);
        }

        async function seedSentInvite(messageId: string) {
            const { user, org } = await seed();
            const invite = await createOrgInvite(getTestDb(), org.id, user.id);
            await getTestDb()
                .update(orgInvites)
                .set({ emailStatus: "sent", emailMessageId: messageId, emailStatusAt: new Date() })
                .where(eq(orgInvites.id, invite.id));
            return invite;
        }

        it("marks the invite bounced on email.bounced", async () => {
            const invite = await seedSentInvite("msg_b1");

            const res = await send({
                type: "email.bounced",
                created_at: "2026-08-22T10:00:00.000Z",
                data: { email_id: "msg_b1", to: [invite.email], bounce: { type: "Permanent" } },
            });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ received: true, handled: true });
            const row = await getInvite(invite.id);
            expect(row.emailStatus).toBe("bounced");
            expect(row.emailStatusAt?.toISOString()).toBe("2026-08-22T10:00:00.000Z");
        });

        it("marks the invite delivered on email.delivered", async () => {
            const invite = await seedSentInvite("msg_d1");
            const res = await send({
                type: "email.delivered",
                created_at: new Date().toISOString(),
                data: { email_id: "msg_d1" },
            });
            expect(res.status).toBe(200);
            expect((await getInvite(invite.id)).emailStatus).toBe("delivered");
        });

        it("acknowledges events for unknown message ids without changing anything", async () => {
            const invite = await seedSentInvite("msg_x");
            const res = await send({
                type: "email.bounced",
                created_at: new Date().toISOString(),
                data: { email_id: "msg_other" },
            });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ received: true, handled: false });
            expect((await getInvite(invite.id)).emailStatus).toBe("sent");
        });

        it("acknowledges but ignores event types it does not track", async () => {
            const invite = await seedSentInvite("msg_o");
            const res = await send({
                type: "email.opened",
                created_at: new Date().toISOString(),
                data: { email_id: "msg_o" },
            });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ received: true, handled: false });
            expect((await getInvite(invite.id)).emailStatus).toBe("sent");
        });

        it("rejects a bad signature with 400 and leaves the invite untouched", async () => {
            const invite = await seedSentInvite("msg_s");
            const res = await send(
                { type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: "msg_s" } },
                { secret: "whsec_" + Buffer.from("wrong").toString("base64") },
            );
            expect(res.status).toBe(400);
            expect((await getInvite(invite.id)).emailStatus).toBe("sent");
        });

        it("rejects a replayed (stale) timestamp", async () => {
            const res = send(
                { type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: "x" } },
                { timestamp: String(Math.floor(Date.now() / 1000) - 3600) },
            );
            expect((await res).status).toBe(400);
        });

        it("rejects a malformed event body", async () => {
            const res = await send({ type: "email.delivered" });
            expect(res.status).toBe(400);
        });
    });
});
