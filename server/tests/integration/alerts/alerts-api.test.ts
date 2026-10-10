/**
 * `GET|PATCH /api/organizations/:id/alerts` and `POST …/alerts/test`
 * (`controllers/alerts.controller.ts`): owners and admins only, reads on any
 * plan, writes and the test send behind the plan gate.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, createUser, addOrgMember, type CreateOrgWithOwnerResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { SendEmailInput, SendEmailResult } from "../../../src/cloud/email/email.service.js";

// Hoisted above the static imports: `src/config` snapshots the environment
// the moment something in the import graph loads it.
vi.hoisted(() => {
    process.env.PUBLIC_API_URL = "https://api.test";
    process.env.DIGEST_UNSUBSCRIBE_SECRET = "alerts-secret";
});

vi.mock("../../../src/lib/slack-webhook.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../../src/lib/slack-webhook.js")>();
    return { ...original, postSlackWebhook: vi.fn(async () => ({ status: "sent" as const })) };
});

async function emailService() {
    return (await import("../../../src/cloud/email/email.service.js")).emailService;
}

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("alert settings API", () => {
    let app: Express;
    let pro: CreateOrgWithOwnerResult;
    let free: CreateOrgWithOwnerResult;
    let sendSpy: MockInstance<(input: SendEmailInput) => Promise<SendEmailResult>>;

    beforeAll(async () => {
        app = await getTestApp();
        vi.spyOn(await emailService(), "isConfigured").mockReturnValue(true);
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        pro = await createOrgWithOwner(db, { email: "owner@pro.test" }, { plan: "pro", name: "Pro Org" });
        free = await createOrgWithOwner(db, { email: "owner@free.test" }, { plan: "free", name: "Free Org" });
        sendSpy = vi.spyOn(await emailService(), "send").mockResolvedValue({ status: "sent", messageId: "msg-t" });
    });

    afterEach(() => sendSpy.mockRestore());

    const headers = (t: CreateOrgWithOwnerResult, user = t.user) =>
        createInternalHeaders({ id: user.id, email: user.email, orgId: t.org.id, orgName: t.org.name, orgSlug: t.org.slug, orgPlan: t.org.plan });
    const url = (t: CreateOrgWithOwnerResult, suffix = "") => `/api/organizations/${t.org.id}/alerts${suffix}`;

    it("reads the settings on any plan and says whether the plan has alerts", async () => {
        const proRes = await request(app).get(url(pro)).set(headers(pro));
        expect(proRes.status).toBe(200);
        expect(proRes.body).toMatchObject({
            available: true,
            plan: "pro",
            emailEnabled: true,
            minSeverity: "critical",
            kev: true,
            slack: { configured: false, masked: null },
            recipients: [{ email: "owner@pro.test" }],
            recentSends: [],
        });

        const freeRes = await request(app).get(url(free)).set(headers(free));
        expect(freeRes.status).toBe(200);
        expect(freeRes.body.available).toBe(false);
    });

    it("refuses writes on a plan without alerts, with a code the client branches on", async () => {
        const res = await request(app).patch(url(free)).set(headers(free)).send({ emailEnabled: false });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("PLAN_REQUIRED");
        const test = await request(app).post(url(free, "/test")).set(headers(free)).send({});
        expect(test.status).toBe(403);
    });

    it("stores a Slack webhook and only ever shows it masked", async () => {
        const res = await request(app)
            .patch(url(pro))
            .set(headers(pro))
            .send({ slackWebhookUrl: "https://hooks.slack.com/services/T000/B000/abcdWXYZ" });
        expect(res.status).toBe(200);
        expect(res.body.slack).toEqual({ configured: true, masked: "hooks.slack.com/…WXYZ" });
        expect(JSON.stringify(res.body)).not.toContain("abcdWXYZ");

        const [org] = await getTestDb().select().from(schema.organizations).where(eq(schema.organizations.id, pro.org.id));
        expect(org!.alertSlackWebhookUrl).toBe("https://hooks.slack.com/services/T000/B000/abcdWXYZ");

        const removed = await request(app).patch(url(pro)).set(headers(pro)).send({ slackWebhookUrl: null });
        expect(removed.body.slack).toEqual({ configured: false, masked: null });
    });

    it("rejects a webhook URL that is not https or not a public host", async () => {
        for (const bad of ["http://hooks.slack.com/services/x/y", "https://localhost/hook", "not a url", "https://user:pw@hooks.slack.com/x"]) {
            const res = await request(app).patch(url(pro)).set(headers(pro)).send({ slackWebhookUrl: bad });
            expect(res.status, bad).toBe(400);
        }
    });

    it("switches email off and on", async () => {
        const off = await request(app).patch(url(pro)).set(headers(pro)).send({ emailEnabled: false });
        expect(off.body.emailEnabled).toBe(false);
        const on = await request(app).patch(url(pro)).set(headers(pro)).send({ emailEnabled: true });
        expect(on.body.emailEnabled).toBe(true);
    });

    it("lets the org choose what is alerted, but not nothing at all", async () => {
        const high = await request(app).patch(url(pro)).set(headers(pro)).send({ minSeverity: "high" });
        expect(high.status).toBe(200);
        expect(high.body).toMatchObject({ minSeverity: "high", kev: true });

        const kevOff = await request(app).patch(url(pro)).set(headers(pro)).send({ kev: false });
        expect(kevOff.body).toMatchObject({ minSeverity: "high", kev: false });

        const nothing = await request(app).patch(url(pro)).set(headers(pro)).send({ minSeverity: "none" });
        expect(nothing.status).toBe(400);

        const kevOnly = await request(app).patch(url(pro)).set(headers(pro)).send({ minSeverity: "none", kev: true });
        expect(kevOnly.body).toMatchObject({ minSeverity: "none", kev: true });

        expect((await request(app).patch(url(pro)).set(headers(pro)).send({ minSeverity: "medium" })).status).toBe(400);
    });

    it("switches alert email off from the signed unsubscribe link, by GET and by one-click POST", async () => {
        const { signUnsubscribeToken } = await import("../../../src/cloud/alerting/unsubscribe-token.js");
        await getTestDb()
            .update(schema.organizations)
            .set({ alertSlackWebhookUrl: "https://hooks.slack.com/services/T000/B000/abcdWXYZ" })
            .where(eq(schema.organizations.id, pro.org.id));

        const get = await request(app).get("/v1/alerts/unsubscribe").query({ token: signUnsubscribeToken("alerts", pro.org.id) });
        expect(get.status).toBe(200);
        expect(get.text).toContain("Alert email switched off");
        let [org] = await getTestDb().select().from(schema.organizations).where(eq(schema.organizations.id, pro.org.id));
        expect(org!.alertEmailEnabled).toBe(false);
        // Slack is untouched: the link is about the inbox it was clicked from.
        expect(org!.alertSlackWebhookUrl).not.toBeNull();

        await request(app).patch(url(pro)).set(headers(pro)).send({ emailEnabled: true });
        const post = await request(app)
            .post("/v1/alerts/unsubscribe")
            .query({ token: signUnsubscribeToken("alerts", pro.org.id) })
            .type("form")
            .send("List-Unsubscribe=One-Click");
        expect(post.status).toBe(200);
        [org] = await getTestDb().select().from(schema.organizations).where(eq(schema.organizations.id, pro.org.id));
        expect(org!.alertEmailEnabled).toBe(false);

        // A digest token is not an alerts token, and a tampered one is nothing.
        expect((await request(app).get("/v1/alerts/unsubscribe").query({ token: signUnsubscribeToken("digest", pro.org.id) })).status).toBe(400);
        expect((await request(app).get("/v1/alerts/unsubscribe").query({ token: "nonsense" })).status).toBe(400);
    });

    it("is owners and admins only", async () => {
        const member = await createUser(getTestDb(), { email: "member@pro.test" });
        await addOrgMember(getTestDb(), member.id, pro.org.id, "member");
        expect((await request(app).get(url(pro)).set(headers(pro, member))).status).toBe(403);
        expect((await request(app).patch(url(pro)).set(headers(pro, member)).send({ emailEnabled: false })).status).toBe(403);
    });

    it("sends a test to the caller's inbox and the webhook, and logs both as tests", async () => {
        await getTestDb()
            .update(schema.organizations)
            .set({ alertSlackWebhookUrl: "https://hooks.slack.com/services/T000/B000/abcdWXYZ" })
            .where(eq(schema.organizations.id, pro.org.id));

        const res = await request(app).post(url(pro, "/test")).set(headers(pro)).send({});

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ email: { status: "sent" }, slack: { status: "sent" } });
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0]![0].to).toBe("owner@pro.test");
        expect(sendSpy.mock.calls[0]![0].subject).toBe("Test alert from StackRadar for Pro Org");
        expect(sendSpy.mock.calls[0]![0].headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

        const sends = await getTestDb().select().from(schema.alertSends).where(eq(schema.alertSends.orgId, pro.org.id));
        expect(sends.map((s) => [s.channel, s.kind]).sort()).toEqual([["email", "test"], ["slack", "test"]]);

        const page = await request(app).get(url(pro)).set(headers(pro));
        expect(page.body.recentSends).toHaveLength(2);
        expect(page.body.recentSends[0]).toMatchObject({ kind: "test", status: "sent" });
    });

    it("refuses a test when no channel is on", async () => {
        await request(app).patch(url(pro)).set(headers(pro)).send({ emailEnabled: false });
        const res = await request(app).post(url(pro, "/test")).set(headers(pro)).send({});
        expect(res.status).toBe(400);
    });
});
