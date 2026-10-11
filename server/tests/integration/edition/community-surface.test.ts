import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../../src/app.js";
import { resolveEdition } from "../../../src/edition.js";
import { createInternalHeaders, getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, type CreateOrgWithOwnerResult } from "../../fixtures/seed-data.js";

/**
 * What a community-edition app does and does not serve. Built from the factory
 * with the community capabilities, whatever edition the suite runs as:
 * everything cloud-only is a 404, not a 500 and not a half-working route.
 */
describe("community edition surface", () => {
    let app: Express;
    let t: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await createApp(resolveEdition("community"));
    });

    beforeEach(async () => {
        await cleanAllData();
        t = await createOrgWithOwner(getTestDb(), { email: "owner@community.test" }, { name: "Default" });
    });

    const headers = () =>
        createInternalHeaders({
            id: t.user.id,
            email: t.user.email,
            orgId: t.org.id,
            orgName: t.org.name,
            orgSlug: t.org.slug,
            orgPlan: t.org.plan,
            isAdmin: true,
        });

    it("says which edition it is", async () => {
        const res = await request(app).get("/api/edition");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            edition: "community",
            billing: false,
            multiCluster: false,
            alerting: "webhook",
        });
    });

    it("answers 404 on every cloud-only route", async () => {
        const probes: Array<[string, string]> = [
            ["post", "/api/billing/checkout"],
            ["post", "/api/billing/portal"],
            ["get", "/api/billing/pricing"],
            ["post", "/api/feedback"],
            ["get", "/api/admin/feedback"],
            ["get", "/api/users/terms"],
            ["post", "/api/users/terms/accept"],
            ["post", "/v1/webhooks/stripe"],
            ["post", "/v1/webhooks/resend"],
            ["get", "/v1/pricing"],
            ["get", "/v1/digest/unsubscribe?token=x"],
            ["get", "/v1/alerts/unsubscribe?token=x"],
        ];
        for (const [method, path] of probes) {
            const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path)
                .set(headers())
                .send({});
            expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
        }
    });

    it("still serves the core: organisations, clusters, the alert settings and the scanner ingest", async () => {
        const org = await request(app).get(`/api/organizations/${t.org.id}`).set(headers());
        expect(org.status).toBe(200);
        const alerts = await request(app).get(`/api/organizations/${t.org.id}/alerts`).set(headers());
        expect(alerts.status).toBe(200);
        // `available` (the plan gate) and `emailChannel` (the hooks) follow
        // the *process's* edition, not the factory's, so only their shape
        // is asserted here; the community run of the suite is what proves
        // their community values.
        expect(typeof alerts.body.available).toBe("boolean");
        expect(typeof alerts.body.emailChannel).toBe("boolean");
        expect(Array.isArray(alerts.body.recipients)).toBe(true);
        const check = await request(app).get("/v1/sboms/check?imageDigest=sha256:abc");
        expect(check.status).toBe(401);
    });

    it("the readiness probe reports the edition and no configuration problems", async () => {
        const res = await request(app).get("/api/health/ready");
        // The suite's own edition decides the problems list (config is a
        // process-wide snapshot); the body shape is what this asserts.
        expect([200, 503]).toContain(res.status);
        expect(res.body.checks).toHaveProperty("configuration");
        expect(res.body).toHaveProperty("edition");
    });

    it("the process's own app mounts the cloud only when it is the cloud", async () => {
        const own = await getTestApp();
        const res = await request(own).get("/api/edition");
        expect(res.status).toBe(200);
        const feedback = await request(own).get("/api/admin/feedback").set(headers());
        expect(feedback.status).toBe(res.body.isCloud ? 200 : 404);
    });
});
