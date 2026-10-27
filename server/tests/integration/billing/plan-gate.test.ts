/**
 * An organization without a plan is read-only (`lib/plan-gate.ts`).
 *
 * `plan = 'free'` is the stored value for "no subscription" — a new org that
 * has not started one, or one whose trial or subscription ended. Reads keep
 * working; every write under `/api` is `403 plan_required` except the way
 * back in (billing) and the way out (deleting the org); the scanner keeps
 * its heartbeat (told `planRequired`) and loses inventory, upload and check.
 * A paying org in the same file proves the gate is scoped, not global.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import { PLAN_REQUIRED_CODE } from "../../../src/lib/plan-gate.js";
import { ALL_LOOKUP_KEYS, resetPriceCatalogForTests } from "../../../src/cloud/billing/stripe-prices.js";
import { resetBetaSlotsForTests } from "../../../src/cloud/billing/beta-slots.service.js";
import { edition } from "../../../src/edition.js";

// Stripe is mocked so the checkout can be shown to pass the gate and reach
// the session, rather than the network.
const mockCustomersCreate = vi.hoisted(() => vi.fn());
const mockCheckoutSessionsCreate = vi.hoisted(() => vi.fn());
const mockPortalSessionsCreate = vi.hoisted(() => vi.fn());
const mockSubscriptionsList = vi.hoisted(() => vi.fn());
const mockPricesList = vi.hoisted(() => vi.fn());
vi.mock("stripe", () => {
    const StripeCtor = vi.fn(function () {
        return {
            customers: { create: mockCustomersCreate },
            checkout: { sessions: { create: mockCheckoutSessionsCreate } },
            billingPortal: { sessions: { create: mockPortalSessionsCreate } },
            webhooks: { constructEvent: vi.fn() },
            subscriptions: { list: mockSubscriptionsList, cancel: vi.fn() },
            prices: { list: mockPricesList },
        };
    });
    (StripeCtor as unknown as { errors: object }).errors = { StripeInvalidRequestError: class extends Error {} };
    return { default: StripeCtor };
});

const DIGEST = `sha256:${"e".repeat(64)}`;

function inventoryReport() {
    return {
        version: 3,
        reportedAt: "2026-10-27T09:00:00.000Z",
        informerSynced: true,
        ownerMetadataCollected: true,
        releases: [],
        applications: [],
        namespaces: [
            {
                name: "default",
                labels: {},
                workloads: [
                    {
                        kind: "Deployment",
                        name: "api",
                        release: null,
                        application: null,
                        runningPods: 1,
                        firstStartedAt: "2026-10-01T10:00:00.000Z",
                        containers: [
                            {
                                name: "main",
                                init: false,
                                imageRef: `ghcr.io/acme/api@${DIGEST}`,
                                imageDigest: DIGEST,
                                imageTag: "1.0.0",
                                registry: "ghcr.io",
                                repository: "acme/api",
                                runningPods: 1,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

// Cloud-only: plans are cloud billing; `STACKRADAR_EDITION=community pnpm test` skips it.
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("plan gate: an organization without a plan is read-only", () => {
    let app: Express;
    let lapsed: SeedTestScenarioResult;
    let paying: SeedTestScenarioResult;

    const headers = (t: SeedTestScenarioResult) =>
        createInternalHeaders({ id: t.user.id, email: t.user.email, orgId: t.org.id, orgPlan: t.org.plan });

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        vi.clearAllMocks();
        resetPriceCatalogForTests();
        resetBetaSlotsForTests();
        mockPricesList.mockResolvedValue({
            object: "list",
            has_more: false,
            data: ALL_LOOKUP_KEYS.map((key) => ({
                id: `price_${key}`,
                lookup_key: key,
                unit_amount: 1000,
                currency: "usd",
            })),
        });
        mockSubscriptionsList.mockResolvedValue({ data: [], has_more: false });
        mockCustomersCreate.mockResolvedValue({ id: "cus_gate" });
        mockCheckoutSessionsCreate.mockResolvedValue({ id: "cs_gate", url: "https://checkout.stripe.com/pay/cs_gate" });
        mockPortalSessionsCreate.mockResolvedValue({
            id: "bps_gate",
            url: "https://billing.stripe.com/p/session/bps_gate",
        });
        const db = getTestDb();
        lapsed = await seedTestScenario(db, { email: "lapsed@test.com" }, { plan: "free", slug: "lapsed" });
        paying = await seedTestScenario(db, { email: "paying@test.com" }, { plan: "pro", slug: "paying" });
    });

    describe("a member of an org without a plan", () => {
        it("reads everything", async () => {
            for (const path of [
                "/api/clusters",
                `/api/clusters/${lapsed.cluster.id}`,
                "/api/containers",
                "/api/images",
                "/api/vulnerabilities",
                `/api/organizations/${lapsed.org.id}`,
                `/api/organizations/${lapsed.org.id}/members`,
                "/api/users/organizations",
            ]) {
                const res = await request(app).get(path).set(headers(lapsed));
                expect(res.status, path).toBe(200);
            }
        });

        it("is refused every write with 403 plan_required", async () => {
            const attempts: Array<[string, request.Test]> = [
                ["POST cluster", request(app).post("/api/clusters").send({ name: "another" })],
                ["DELETE cluster", request(app).delete(`/api/clusters/${lapsed.cluster.id}`)],
                [
                    "PATCH org settings",
                    request(app).patch(`/api/organizations/${lapsed.org.id}`).send({ name: "Renamed" }),
                ],
                [
                    "PATCH alerts",
                    request(app).patch(`/api/organizations/${lapsed.org.id}/alerts`).send({ emailEnabled: false }),
                ],
                [
                    "POST invite",
                    request(app)
                        .post(`/api/organizations/${lapsed.org.id}/invites`)
                        .send({ email: "x@test.com", role: "member" }),
                ],
            ];
            for (const [label, attempt] of attempts) {
                const res = await attempt.set(headers(lapsed));
                expect(res.status, label).toBe(403);
                expect(res.body.code, label).toBe(PLAN_REQUIRED_CODE);
                expect(res.body.error, label).toMatch(/start a plan/i);
            }
        });

        it("can still check out, open billing and delete the org", async () => {
            const checkout = await request(app).post("/api/billing/checkout").set(headers(lapsed)).send({
                plan: "pro",
                successUrl: "http://localhost:3000/?billing=success",
                cancelUrl: "http://localhost:3000/",
            });
            expect(checkout.status).toBe(200);
            expect(checkout.body).toEqual({ url: "https://checkout.stripe.com/pay/cs_gate", trial: true });

            // The checkout above created the Stripe customer, so the portal
            // (where a lapsed org resumes or re-subscribes) opens too.
            const portal = await request(app)
                .post("/api/billing/portal")
                .set(headers(lapsed))
                .send({ returnUrl: "http://localhost:3000/org-settings" });
            expect(portal.status).toBe(200);
            expect(portal.body.url).toBe("https://billing.stripe.com/p/session/bps_gate");

            const pricing = await request(app).get("/api/billing/pricing").set(headers(lapsed));
            expect(pricing.status).toBe(200);

            const feedback = await request(app)
                .post("/api/feedback")
                .set(headers(lapsed))
                .send({ message: "please let me back in" });
            expect(feedback.status).toBe(201);

            const del = await request(app).delete(`/api/organizations/${lapsed.org.id}`).set(headers(lapsed));
            expect(del.status).toBe(200);
        });
    });

    describe("the scanner key of an org without a plan", () => {
        it("keeps its heartbeat and is told a plan is required", async () => {
            const res = await request(app).post("/v1/heartbeat").set(createApiKeyHeaders(lapsed.apiKey.rawKey));
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ ok: true, planRequired: true });
        });

        it("is refused inventory, upload and the check with 403 plan_required", async () => {
            const key = createApiKeyHeaders(lapsed.apiKey.rawKey);
            const inventory = await request(app).post("/v1/inventory").set(key).send(inventoryReport());
            expect(inventory.status).toBe(403);
            expect(inventory.body.code).toBe(PLAN_REQUIRED_CODE);

            const check = await request(app).get(`/v1/sboms/check?imageDigest=${DIGEST}`).set(key);
            expect(check.status).toBe(403);
            expect(check.body.code).toBe(PLAN_REQUIRED_CODE);

            const upload = await request(app)
                .post(`/v1/sboms/upload/cyclonedx?imageDigest=${DIGEST}&imageRef=ghcr.io/acme/api:1.0.0`)
                .set(key)
                .send({ bomFormat: "CycloneDX", specVersion: "1.5", components: [] });
            expect(upload.status).toBe(403);
            expect(upload.body.code).toBe(PLAN_REQUIRED_CODE);
        });
    });

    describe("a paying org in the same database", () => {
        it("writes as before, and its scanner is not told anything", async () => {
            const create = await request(app).post("/api/clusters").set(headers(paying)).send({ name: "prod-2" });
            expect(create.status).toBe(201);

            const rename = await request(app)
                .patch(`/api/organizations/${paying.org.id}`)
                .set(headers(paying))
                .send({ name: "Renamed Org" });
            expect(rename.status).toBe(200);

            const key = createApiKeyHeaders(paying.apiKey.rawKey);
            const heartbeat = await request(app).post("/v1/heartbeat").set(key);
            expect(heartbeat.status).toBe(200);
            expect(heartbeat.body.planRequired).toBeUndefined();

            const inventory = await request(app).post("/v1/inventory").set(key).send(inventoryReport());
            expect(inventory.status).toBe(200);

            const check = await request(app).get(`/v1/sboms/check?imageDigest=${DIGEST}`).set(key);
            expect(check.status).toBe(200);
        });
    });
});
