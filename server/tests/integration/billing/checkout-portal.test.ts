import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner, createUser, addOrgMember, type CreateOrgWithOwnerResult } from "../../fixtures/seed-data.js";
import { organizations } from "../../../src/db/schema/index.js";
import { ALL_LOOKUP_KEYS, resetPriceCatalogForTests } from "../../../src/cloud/billing/stripe-prices.js";
import { resetBetaSlotsForTests } from "../../../src/cloud/billing/beta-slots.service.js";
import { BETA_PRICE_SLOTS } from "../../../src/cloud/billing/plans.js";

/**
 * The full price catalog as Stripe would list it by lookup key: the price ID
 * is the key with a `price_` prefix, so a test can name the price it expects
 * without a table.
 */
const CATALOG = {
    object: "list",
    has_more: false,
    data: ALL_LOOKUP_KEYS.map((key) => ({ id: `price_${key}`, lookup_key: key, unit_amount: 1000, currency: "usd" })),
};

/** `subscriptions.list` answers: `n` claimed slots on any beta price, nothing on a customer. */
function stripeSlotsClaimed(n: number, status = "active") {
    mockSubscriptionsList.mockImplementation(async (params: { price?: string; customer?: string }) => {
        if (params.price?.endsWith("_monthly")) {
            return { data: Array.from({ length: n }, (_, i) => ({ id: `sub_${i}`, status })), has_more: false };
        }
        return { data: [], has_more: false };
    });
}

// ---------------------------------------------------------------------------
// Mock the Stripe SDK — no real HTTP calls
// ---------------------------------------------------------------------------
const mockCustomersCreate = vi.hoisted(() => vi.fn());
const mockCheckoutSessionsCreate = vi.hoisted(() => vi.fn());
const mockPortalSessionsCreate = vi.hoisted(() => vi.fn());
const mockSubscriptionsList = vi.hoisted(() => vi.fn());
const mockSubscriptionsCancel = vi.hoisted(() => vi.fn());
const mockPricesList = vi.hoisted(() => vi.fn());

// The controller narrows caught errors with `instanceof
// Stripe.errors.StripeInvalidRequestError`, so the mock must carry a real
// class under `.errors` for that check to work.
const MockStripeInvalidRequestError = vi.hoisted(() => class MockStripeInvalidRequestError extends Error {});

vi.mock("stripe", () => {
    const StripeCtor = vi.fn().mockImplementation(() => ({
        customers: { create: mockCustomersCreate },
        checkout: { sessions: { create: mockCheckoutSessionsCreate } },
        billingPortal: { sessions: { create: mockPortalSessionsCreate } },
        webhooks: { constructEvent: vi.fn() },
        subscriptions: { retrieve: vi.fn(), list: mockSubscriptionsList, cancel: mockSubscriptionsCancel },
        prices: { list: mockPricesList },
    }));
    (StripeCtor as unknown as { errors: object }).errors = {
        StripeInvalidRequestError: MockStripeInvalidRequestError,
    };
    return { default: StripeCtor };
});

// ---------------------------------------------------------------------------
// POST /api/billing/checkout
// ---------------------------------------------------------------------------

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("POST /api/billing/checkout", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        vi.clearAllMocks();
        resetPriceCatalogForTests();
        resetBetaSlotsForTests();
        mockPricesList.mockResolvedValue(CATALOG);
        mockSubscriptionsList.mockResolvedValue({ data: [] });
        testData = await createOrgWithOwner(getTestDb());
    });

    const ownerHeaders = () => createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug });

    it("should create a Stripe customer and return a checkout URL for a new org", async () => {
        mockCustomersCreate.mockResolvedValue({ id: "cus_new_123" });
        mockCheckoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test", id: "cs_test_123" });

        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(200);
        expect(res.body.url).toBe("https://checkout.stripe.com/pay/cs_test");
        expect(mockCustomersCreate).toHaveBeenCalledOnce();
        // The billing email is the customer's to set in Checkout — the login
        // email of whoever clicked upgrade must not be copied onto the
        // Stripe customer.
        expect(mockCustomersCreate).toHaveBeenCalledWith({ name: testData.org.name });

        // Customer ID must be persisted so the next checkout reuses it
        const [updated] = await getTestDb().select().from(organizations).where(eq(organizations.id, testData.org.id));
        expect(updated!.stripeCustomerId).toBe("cus_new_123");
    });

    it("should reuse an existing Stripe customer without calling customers.create", async () => {
        await getTestDb()
            .update(organizations)
            .set({ stripeCustomerId: "cus_existing_456" })
            .where(eq(organizations.id, testData.org.id));

        mockCheckoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_reuse", id: "cs_test_456" });

        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(200);
        expect(res.body.url).toBe("https://checkout.stripe.com/pay/cs_reuse");
        expect(mockCustomersCreate).not.toHaveBeenCalled();
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
            expect.objectContaining({ customer: "cus_existing_456" }),
        );
    });

    it("charges the beta monthly Pro price while Pro has a free slot", async () => {
        mockCustomersCreate.mockResolvedValue({ id: "cus_new_123" });
        mockCheckoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test", id: "cs_1" });
        stripeSlotsClaimed(BETA_PRICE_SLOTS.pro - 1);

        const res = await request(app).post("/api/billing/checkout").set(ownerHeaders())
            .send({ plan: "pro", successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(200);
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
            line_items: [{ price: "price_stackradar_pro_monthly", quantity: 1 }],
            subscription_data: { metadata: { orgId: testData.org.id, priceBook: "beta" } },
        }));
    });

    it("charges the standard price once the plan's beta slots are taken", async () => {
        mockCustomersCreate.mockResolvedValue({ id: "cus_new_123" });
        mockCheckoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test", id: "cs_1" });
        stripeSlotsClaimed(BETA_PRICE_SLOTS.pro);

        const res = await request(app).post("/api/billing/checkout").set(ownerHeaders())
            .send({ plan: "pro", successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(200);
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
            line_items: [{ price: "price_stackradar_pro_monthly_standard", quantity: 1 }],
            subscription_data: { metadata: { orgId: testData.org.id, priceBook: "standard" } },
        }));
    });

    it("does not count incomplete checkouts as taken slots, but does count cancelled ones", async () => {
        mockCustomersCreate.mockResolvedValue({ id: "cus_new_123" });
        mockCheckoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test", id: "cs_1" });

        stripeSlotsClaimed(BETA_PRICE_SLOTS.pro, "incomplete");
        await request(app).post("/api/billing/checkout").set(ownerHeaders())
            .send({ plan: "pro", successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });
        expect(mockCheckoutSessionsCreate).toHaveBeenLastCalledWith(expect.objectContaining({
            line_items: [{ price: "price_stackradar_pro_monthly", quantity: 1 }],
        }));

        resetBetaSlotsForTests();
        stripeSlotsClaimed(BETA_PRICE_SLOTS.pro, "canceled");
        await request(app).post("/api/billing/checkout").set(ownerHeaders())
            .send({ plan: "pro", successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });
        expect(mockCheckoutSessionsCreate).toHaveBeenLastCalledWith(expect.objectContaining({
            line_items: [{ price: "price_stackradar_pro_monthly_standard", quantity: 1 }],
        }));
    });

    it("sells annual billing on the plan's annual price, and Business on its own slots", async () => {
        mockCustomersCreate.mockResolvedValue({ id: "cus_new_123" });
        mockCheckoutSessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/pay/cs_test", id: "cs_1" });
        // Pro's slots are gone; Business still has all of its own.
        mockSubscriptionsList.mockImplementation(async (params: { price?: string }) => ({
            data: params.price === "price_stackradar_pro_monthly"
                ? Array.from({ length: BETA_PRICE_SLOTS.pro }, (_, i) => ({ id: `sub_${i}`, status: "active" }))
                : [],
            has_more: false,
        }));

        const res = await request(app).post("/api/billing/checkout").set(ownerHeaders())
            .send({ plan: "team", interval: "year", successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(200);
        expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({
            line_items: [{ price: "price_stackradar_team_annual", quantity: 1 }],
        }));
    });

    it("returns 500 naming the lookup key when the catalog lacks the price", async () => {
        mockCustomersCreate.mockResolvedValue({ id: "cus_new_123" });
        mockPricesList.mockResolvedValue({ ...CATALOG, data: CATALOG.data.filter((p) => !p.lookup_key.includes("annual")) });

        const res = await request(app).post("/api/billing/checkout").set(ownerHeaders())
            .send({ plan: "pro", interval: "year", successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(500);
        expect(res.body.error ?? res.body.message ?? JSON.stringify(res.body)).toContain("stackradar_pro_annual");
        expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 400 when org is already on the Pro plan", async () => {
        await getTestDb()
            .update(organizations)
            .set({ plan: "pro" })
            .where(eq(organizations.id, testData.org.id));

        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug, orgPlan: "pro" }))
            .send({ successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(400);
        expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 400 when successUrl is not an allowed origin", async () => {
        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ successUrl: "https://evil.example.com/steal", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(400);
        expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 400 when successUrl is missing", async () => {
        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(400);
    });

    it("should return 400 when cancelUrl is missing", async () => {
        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ successUrl: "http://localhost:3000/success" });

        expect(res.status).toBe(400);
    });

    it("should return 400 when the customer already has a live subscription (webhook still in flight)", async () => {
        await getTestDb()
            .update(organizations)
            .set({ stripeCustomerId: "cus_existing_456" })
            .where(eq(organizations.id, testData.org.id));

        mockSubscriptionsList.mockResolvedValue({ data: [{ id: "sub_live", status: "active" }] });

        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(400);
        expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 403 when the caller is a plain member", async () => {
        const member = await createUser(getTestDb());
        await addOrgMember(getTestDb(), member.id, testData.org.id, "member");

        const res = await request(app)
            .post("/api/billing/checkout")
            .set(createInternalHeaders({ id: member.id, email: member.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(403);
        expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 401 when unauthenticated", async () => {
        const res = await request(app)
            .post("/api/billing/checkout")
            .send({ successUrl: "http://localhost:3000/success", cancelUrl: "http://localhost:3000/cancel" });

        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// GET /v1/pricing and GET /api/billing/pricing — the beta slot counter
// ---------------------------------------------------------------------------

describeCloud("beta slot counter", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        vi.clearAllMocks();
        resetPriceCatalogForTests();
        resetBetaSlotsForTests();
        mockPricesList.mockResolvedValue(CATALOG);
        testData = await createOrgWithOwner(getTestDb());
    });

    it("GET /v1/pricing is public and reports total and claimed per plan, capped at total", async () => {
        stripeSlotsClaimed(BETA_PRICE_SLOTS.pro + 3);

        const res = await request(app).get("/v1/pricing");

        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toContain("max-age=60");
        expect(res.body).toEqual({
            betaSlots: {
                pro: { total: BETA_PRICE_SLOTS.pro, claimed: BETA_PRICE_SLOTS.pro },
                team: { total: BETA_PRICE_SLOTS.team, claimed: BETA_PRICE_SLOTS.team },
            },
        });
    });

    it("sums monthly and annual subscriptions into the plan's count", async () => {
        mockSubscriptionsList.mockImplementation(async (params: { price?: string }) => ({
            data: params.price === "price_stackradar_pro_monthly" || params.price === "price_stackradar_pro_annual"
                ? [{ id: "sub", status: "active" }]
                : [],
            has_more: false,
        }));

        const res = await request(app).get("/v1/pricing");

        expect(res.body.betaSlots.pro.claimed).toBe(2);
        expect(res.body.betaSlots.team.claimed).toBe(0);
    });

    it("serves the cached count and drops it on a subscription webhook", async () => {
        stripeSlotsClaimed(1);
        expect((await request(app).get("/v1/pricing")).body.betaSlots.pro.claimed).toBe(1);

        stripeSlotsClaimed(2);
        // Still cached: Stripe is not asked again within the TTL.
        expect((await request(app).get("/v1/pricing")).body.betaSlots.pro.claimed).toBe(1);

        // The webhook path invalidates; the signature check fails first in
        // this mock, so call the seam the webhook uses instead.
        resetBetaSlotsForTests();
        expect((await request(app).get("/v1/pricing")).body.betaSlots.pro.claimed).toBe(2);
    });

    it("answers 503 rather than a made-up count when Stripe fails", async () => {
        mockPricesList.mockRejectedValue(new Error("stripe down"));

        const res = await request(app).get("/v1/pricing");

        expect(res.status).toBe(503);
    });

    it("GET /api/billing/pricing requires a session and returns the same payload", async () => {
        stripeSlotsClaimed(0);

        expect((await request(app).get("/api/billing/pricing")).status).toBe(401);

        const res = await request(app)
            .get("/api/billing/pricing")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }));
        expect(res.status).toBe(200);
        expect(res.body.betaSlots.pro).toEqual({ total: BETA_PRICE_SLOTS.pro, claimed: 0 });
    });
});

// ---------------------------------------------------------------------------
// POST /api/billing/portal
// ---------------------------------------------------------------------------

describeCloud("POST /api/billing/portal", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        vi.clearAllMocks();
        testData = await createOrgWithOwner(getTestDb());
    });

    it("should return a portal URL for an org with a Stripe customer", async () => {
        await getTestDb()
            .update(organizations)
            .set({ stripeCustomerId: "cus_portal_123", plan: "pro" })
            .where(eq(organizations.id, testData.org.id));

        mockPortalSessionsCreate.mockResolvedValue({ url: "https://billing.stripe.com/session/bps_test" });

        const res = await request(app)
            .post("/api/billing/portal")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug, orgPlan: "pro" }))
            .send({ returnUrl: "http://localhost:3000/billing" });

        expect(res.status).toBe(200);
        expect(res.body.url).toBe("https://billing.stripe.com/session/bps_test");
        expect(mockPortalSessionsCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                customer: "cus_portal_123",
                return_url: "http://localhost:3000/billing",
            }),
        );
    });

    it("should return 400 when org has no Stripe customer", async () => {
        const res = await request(app)
            .post("/api/billing/portal")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ returnUrl: "http://localhost:3000/billing" });

        expect(res.status).toBe(400);
    });

    it("should return 400 when returnUrl is missing", async () => {
        await getTestDb()
            .update(organizations)
            .set({ stripeCustomerId: "cus_portal_123" })
            .where(eq(organizations.id, testData.org.id));

        const res = await request(app)
            .post("/api/billing/portal")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({});

        expect(res.status).toBe(400);
    });

    it("should return 400 when returnUrl is not an allowed origin", async () => {
        await getTestDb()
            .update(organizations)
            .set({ stripeCustomerId: "cus_portal_123" })
            .where(eq(organizations.id, testData.org.id));

        const res = await request(app)
            .post("/api/billing/portal")
            .set(createInternalHeaders({ id: testData.user.id, email: testData.user.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ returnUrl: "http://localhost:3000.evil.com/billing" });

        expect(res.status).toBe(400);
        expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 403 when the caller is a plain member", async () => {
        await getTestDb()
            .update(organizations)
            .set({ stripeCustomerId: "cus_portal_123" })
            .where(eq(organizations.id, testData.org.id));
        const member = await createUser(getTestDb());
        await addOrgMember(getTestDb(), member.id, testData.org.id, "member");

        const res = await request(app)
            .post("/api/billing/portal")
            .set(createInternalHeaders({ id: member.id, email: member.email, orgId: testData.org.id, orgName: testData.org.name, orgSlug: testData.org.slug }))
            .send({ returnUrl: "http://localhost:3000/billing" });

        expect(res.status).toBe(403);
        expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
    });

    it("should return 401 when unauthenticated", async () => {
        const res = await request(app)
            .post("/api/billing/portal")
            .send({ returnUrl: "http://localhost:3000/billing" });

        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/organizations/:id — subscription cleanup
// ---------------------------------------------------------------------------

describeCloud("DELETE /api/organizations/:id (subscription cleanup)", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    const ownerHeaders = () => createInternalHeaders({
        id: testData.user.id,
        email: testData.user.email,
        orgId: testData.org.id,
        orgName: testData.org.name,
        orgSlug: testData.org.slug,
    });

    const getOrgRow = async () => {
        const [row] = await getTestDb().select().from(organizations).where(eq(organizations.id, testData.org.id));
        return row!;
    };

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        vi.clearAllMocks();
        testData = await createOrgWithOwner(getTestDb());
    });

    it("should cancel the Stripe subscription and clear billing state before soft-deleting", async () => {
        await getTestDb()
            .update(organizations)
            .set({
                plan: "pro",
                stripeCustomerId: "cus_del_1",
                stripeSubscriptionId: "sub_del_1",
                stripeSubscriptionStatus: "active",
            })
            .where(eq(organizations.id, testData.org.id));
        mockSubscriptionsCancel.mockResolvedValue({ id: "sub_del_1", status: "canceled" });

        const res = await request(app)
            .delete(`/api/organizations/${testData.org.id}`)
            .set(ownerHeaders());

        expect(res.status).toBe(200);
        expect(mockSubscriptionsCancel).toHaveBeenCalledWith("sub_del_1");

        const row = await getOrgRow();
        expect(row.deletedAt).not.toBeNull();
        expect(row.plan).toBe("free");
        expect(row.stripeSubscriptionId).toBeNull();
        expect(row.stripeSubscriptionStatus).toBeNull();
        // Customer is kept, mirroring the subscription.deleted webhook path.
        expect(row.stripeCustomerId).toBe("cus_del_1");
    });

    it("should still delete when Stripe reports the subscription already gone", async () => {
        await getTestDb()
            .update(organizations)
            .set({ plan: "pro", stripeCustomerId: "cus_del_2", stripeSubscriptionId: "sub_del_2" })
            .where(eq(organizations.id, testData.org.id));
        mockSubscriptionsCancel.mockRejectedValue(new MockStripeInvalidRequestError("No such subscription"));

        const res = await request(app)
            .delete(`/api/organizations/${testData.org.id}`)
            .set(ownerHeaders());

        expect(res.status).toBe(200);
        expect((await getOrgRow()).deletedAt).not.toBeNull();
    });

    it("should abort the deletion when the cancellation fails", async () => {
        await getTestDb()
            .update(organizations)
            .set({ plan: "pro", stripeCustomerId: "cus_del_3", stripeSubscriptionId: "sub_del_3" })
            .where(eq(organizations.id, testData.org.id));
        mockSubscriptionsCancel.mockRejectedValue(new Error("stripe unreachable"));

        const res = await request(app)
            .delete(`/api/organizations/${testData.org.id}`)
            .set(ownerHeaders());

        expect(res.status).toBe(500);
        const row = await getOrgRow();
        expect(row.deletedAt).toBeNull();
        expect(row.plan).toBe("pro");
        expect(row.stripeSubscriptionId).toBe("sub_del_3");
    });

    it("should delete without touching Stripe when the org has no subscription", async () => {
        const res = await request(app)
            .delete(`/api/organizations/${testData.org.id}`)
            .set(ownerHeaders());

        expect(res.status).toBe(200);
        expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
        expect((await getOrgRow()).deletedAt).not.toBeNull();
    });
});
