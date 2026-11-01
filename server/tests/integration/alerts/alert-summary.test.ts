/**
 * `GET /api/organizations/:id/notifications/summary`
 * (`controllers/alerts.controller.ts` `summary`): readable by any member of
 * the org, it says which channels exist and are on — the webhook's host and
 * a recipient count — and never the webhook URL or an email address. Those
 * stay on the owner/admin `…/alerts` read.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createUser,
    addOrgMember,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { edition } from "../../../src/edition.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/abcdWXYZ";

describe("alert channel summary API", () => {
    let app: Express;
    let org: CreateOrgWithOwnerResult;
    let member: schema.User;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        org = await createOrgWithOwner(db, { email: "owner@summary.test" }, { plan: "pro", name: "Summary Org" });
        member = await createUser(db, { email: "member@summary.test" });
        await addOrgMember(db, member.id, org.org.id, "member");
    });

    const headers = (user: { id: string; email: string }) =>
        createInternalHeaders({
            id: user.id,
            email: user.email,
            orgId: org.org.id,
            orgName: org.org.name,
            orgSlug: org.org.slug,
            orgPlan: org.org.plan,
        });
    const url = () => `/api/organizations/${org.org.id}/notifications/summary`;

    it("tells a member the webhook's host and the recipient count, never the URL or an address", async () => {
        await getTestDb()
            .update(schema.organizations)
            .set({ alertSlackWebhookUrl: WEBHOOK })
            .where(eq(schema.organizations.id, org.org.id));

        const res = await request(app).get(url()).set(headers(member));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            available: true,
            webhookConfigured: true,
            webhookHost: "hooks.slack.com",
        });
        if (edition.alerting === "full") {
            // The cloud's email channel reaches the one owner; the member is not an admin.
            expect(res.body).toMatchObject({ emailChannel: true, emailEnabled: true, recipientCount: 1 });
        } else {
            expect(res.body).toMatchObject({ emailChannel: false, emailEnabled: false, recipientCount: 0 });
        }

        const body = JSON.stringify(res.body);
        expect(body).not.toContain("abcdWXYZ");
        expect(body).not.toContain("/services/");
        expect(body).not.toContain("owner@summary.test");
        expect(body).not.toContain("member@summary.test");
        expect(Object.keys(res.body).sort()).toEqual(
            ["available", "emailChannel", "emailEnabled", "recipientCount", "webhookConfigured", "webhookHost"].sort(),
        );
    });

    it("answers a not-configured shape for an org without a webhook", async () => {
        await getTestDb()
            .update(schema.organizations)
            .set({ alertEmailEnabled: false })
            .where(eq(schema.organizations.id, org.org.id));

        const res = await request(app).get(url()).set(headers(member));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            webhookConfigured: false,
            webhookHost: null,
            emailEnabled: false,
        });
    });

    it("is readable by the owner too, and by nobody outside the org", async () => {
        expect((await request(app).get(url()).set(headers(org.user))).status).toBe(200);

        const stranger = await createUser(getTestDb(), { email: "stranger@elsewhere.test" });
        const res = await request(app).get(url()).set(headers(stranger));
        expect(res.status).toBe(403);
    });
});
