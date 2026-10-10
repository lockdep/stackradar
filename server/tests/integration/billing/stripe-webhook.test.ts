import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createOrgWithOwner } from "../../fixtures/seed-data.js";
import { organizations } from "../../../src/db/schema/index.js";
import {
    SUBSCRIPTION_UPDATED,
    CHECKOUT_COMPLETED,
    SUBSCRIPTION_DELETED,
    RETRIEVED_SUBSCRIPTION,
} from "./stripe-fixtures.js";

// ---------------------------------------------------------------------------
// Stripe SDK mock — no real HTTP calls, no signature crypto
// ---------------------------------------------------------------------------
const mockConstructEvent = vi.hoisted(() => vi.fn());
const mockSubscriptionsList = vi.hoisted(() => vi.fn());
const mockProductsRetrieve = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({
    default: vi.fn().mockImplementation(() => ({
        webhooks: { constructEvent: mockConstructEvent },
        subscriptions: { list: mockSubscriptionsList },
        products: { retrieve: mockProductsRetrieve },
    })),
}));

const LIST_EXPAND = ["data.items.data.price"];

/** What Stripe returns for `subscriptions.list` — the customer's live state. */
function stripeHas(...subscriptions: object[]) {
    mockSubscriptionsList.mockResolvedValue({ object: "list", data: subscriptions, has_more: false });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOMER_UPDATED  = "cus_UZ6Rju6nYPzDdQ"; // customer in SUBSCRIPTION_UPDATED / CHECKOUT_COMPLETED
const CUSTOMER_DELETED  = "cus_UYg9daEXUkJfnf"; // customer in SUBSCRIPTION_DELETED
const SUBSCRIPTION_ID   = "sub_1TZyF6D3cuA0MfJp1rz7w3zP";

async function seedProOrg(customerId: string) {
    const db = getTestDb();
    const { org } = await createOrgWithOwner(db, {}, { plan: "pro" });
    await db.update(organizations)
        .set({ stripeCustomerId: customerId, stripeSubscriptionId: SUBSCRIPTION_ID })
        .where(eq(organizations.id, org.id));
    return org;
}

async function seedFreeOrg(customerId: string) {
    const db = getTestDb();
    const { org } = await createOrgWithOwner(db, {}, { plan: "free" });
    await db.update(organizations)
        .set({ stripeCustomerId: customerId })
        .where(eq(organizations.id, org.id));
    return org;
}

async function getOrg(orgId: string) {
    const db = getTestDb();
    const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    return row!;
}

function sendWebhook(app: Express, event: object) {
    return request(app)
        .post("/v1/webhooks/stripe")
        .set("stripe-signature", "t=1,v1=fakesig")
        .set("content-type", "application/json")
        .send(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("POST /v1/webhooks/stripe", () => {
    let app: Express;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        vi.clearAllMocks();
        // Fixtures carry string product IDs; the default product has no plan
        // metadata, and the price catalog is not mocked here, so tiers fall
        // through to the logged "default to pro" path.
        mockProductsRetrieve.mockReset().mockResolvedValue({ id: "prod_UXyM0ZmTgTHXOL", object: "product", metadata: {} });
    });

    // -----------------------------------------------------------------------
    describe("customer.subscription.updated", () => {
        it("upgrades free org to pro when subscription is active", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            stripeHas(SUBSCRIPTION_UPDATED.data.object);

            const res = await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect(res.status).toBe(200);
            expect(res.body.received).toBe(true);
            const updated = await getOrg(org.id);
            expect(updated.plan).toBe("pro");
            expect(updated.stripeCustomerId).toBe(CUSTOMER_UPDATED);
            expect(updated.stripeSubscriptionId).toBe(SUBSCRIPTION_ID);
        });

        it("re-fetches the subscription instead of trusting the event payload (events can arrive out of order)", async () => {
            const org = await seedProOrg(CUSTOMER_UPDATED);
            // The event claims "canceled", but the API says the subscription is
            // currently active — live truth must win over a stale/delayed event.
            const staleEvent = {
                ...SUBSCRIPTION_UPDATED,
                data: { ...SUBSCRIPTION_UPDATED.data, object: { ...SUBSCRIPTION_UPDATED.data.object, status: "canceled" } },
            };
            mockConstructEvent.mockReturnValue(staleEvent);
            stripeHas(SUBSCRIPTION_UPDATED.data.object);

            await sendWebhook(app, staleEvent);

            expect(mockSubscriptionsList).toHaveBeenCalledWith(
                expect.objectContaining({ customer: CUSTOMER_UPDATED, status: "all", expand: LIST_EXPAND }),
            );
            expect((await getOrg(org.id)).plan).toBe("pro");
        });

        it("keeps org on pro when cancellation is scheduled but subscription is still active", async () => {
            // Real payload: cancel_at is set (future), cancel_at_period_end=false, status="active"
            // User cancelled via portal — Stripe schedules the end date but keeps them active.
            // They should stay on pro until customer.subscription.deleted fires.
            const org = await seedProOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            stripeHas(SUBSCRIPTION_UPDATED.data.object);

            const res = await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect(res.status).toBe(200);
            expect((await getOrg(org.id)).plan).toBe("pro");
        });

        it("upgrades org to pro when subscription is trialing", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            const trialingEvent = {
                ...SUBSCRIPTION_UPDATED,
                data: { ...SUBSCRIPTION_UPDATED.data, object: { ...SUBSCRIPTION_UPDATED.data.object, status: "trialing" } },
            };
            mockConstructEvent.mockReturnValue(trialingEvent);
            stripeHas(trialingEvent.data.object);

            await sendWebhook(app, trialingEvent);

            expect((await getOrg(org.id)).plan).toBe("pro");
        });

        it("keeps org on pro while subscription is past_due (Stripe is still retrying payment)", async () => {
            // Payment failed — Stripe's smart retries and dunning emails run for
            // days. Downgrading now would start deleting history over a card
            // hiccup; the terminal outcome arrives later as canceled/unpaid or
            // customer.subscription.deleted.
            const org = await seedProOrg(CUSTOMER_UPDATED);
            const pastDueEvent = {
                ...SUBSCRIPTION_UPDATED,
                data: { ...SUBSCRIPTION_UPDATED.data, object: { ...SUBSCRIPTION_UPDATED.data.object, status: "past_due" } },
            };
            mockConstructEvent.mockReturnValue(pastDueEvent);
            stripeHas(pastDueEvent.data.object);

            await sendWebhook(app, pastDueEvent);

            const updated = await getOrg(org.id);
            expect(updated.plan).toBe("pro");
            expect(updated.stripeSubscriptionStatus).toBe("past_due");
        });

        it("downgrades org to free when subscription becomes unpaid (retries exhausted)", async () => {
            const org = await seedProOrg(CUSTOMER_UPDATED);
            const unpaidEvent = {
                ...SUBSCRIPTION_UPDATED,
                data: { ...SUBSCRIPTION_UPDATED.data, object: { ...SUBSCRIPTION_UPDATED.data.object, status: "unpaid" } },
            };
            mockConstructEvent.mockReturnValue(unpaidEvent);
            stripeHas(unpaidEvent.data.object);

            await sendWebhook(app, unpaidEvent);

            expect((await getOrg(org.id)).plan).toBe("free");
        });

        function withProduct(product: object | string) {
            const base = SUBSCRIPTION_UPDATED.data.object;
            const item = base.items.data[0]!;
            return {
                ...base,
                items: { ...base.items, data: [{ ...item, price: { ...item.price, product } }] },
            };
        }

        it("resolves the team tier from an expanded product's metadata.plan", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            stripeHas(withProduct({ id: "prod_team", object: "product", metadata: { plan: "team" } }));

            await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect((await getOrg(org.id)).plan).toBe("team");
            expect(mockProductsRetrieve).not.toHaveBeenCalled();
        });

        it("fetches the product by ID when Stripe returns it unexpanded (expand depth cap)", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            mockProductsRetrieve.mockResolvedValue({ id: "prod_team", object: "product", metadata: { plan: "team" } });
            stripeHas(withProduct("prod_team"));

            await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect(mockProductsRetrieve).toHaveBeenCalledWith("prod_team");
            expect((await getOrg(org.id)).plan).toBe("team");
        });

        it("falls back to the configured price IDs when the product fetch fails", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            mockProductsRetrieve.mockRejectedValue(new Error("stripe down"));
            stripeHas(withProduct("prod_whatever"));

            await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect((await getOrg(org.id)).plan).toBe("pro");
        });

        it("returns 200 without touching the DB when no org matches the customer ID", async () => {
            // No org seeded — should silently no-op, not 500
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            stripeHas(SUBSCRIPTION_UPDATED.data.object);

            const res = await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect(res.status).toBe(200);
            expect(res.body.received).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    describe("checkout.session.completed", () => {
        it("upgrades free org to pro and stores the subscription ID", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(CHECKOUT_COMPLETED);
            stripeHas(RETRIEVED_SUBSCRIPTION);

            const res = await sendWebhook(app, CHECKOUT_COMPLETED);

            expect(res.status).toBe(200);
            const updated = await getOrg(org.id);
            expect(updated.plan).toBe("pro");
            expect(updated.stripeSubscriptionId).toBe(SUBSCRIPTION_ID);
        });

        it("lists the checkout customer's subscriptions rather than trusting the session", async () => {
            await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(CHECKOUT_COMPLETED);
            stripeHas(RETRIEVED_SUBSCRIPTION);

            await sendWebhook(app, CHECKOUT_COMPLETED);

            expect(mockSubscriptionsList).toHaveBeenCalledWith(
                expect.objectContaining({ customer: CUSTOMER_UPDATED, status: "all", expand: LIST_EXPAND }),
            );
        });

        it("leaves the org on free when checkout completed but the subscription is not yet paid (async payment method)", async () => {
            // SEPA / bank debit: the session completes before funds clear and
            // the subscription sits in "incomplete" until invoice.paid — the
            // later customer.subscription.updated is what upgrades the org.
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            mockConstructEvent.mockReturnValue(CHECKOUT_COMPLETED);
            stripeHas({ ...RETRIEVED_SUBSCRIPTION, status: "incomplete" });

            await sendWebhook(app, CHECKOUT_COMPLETED);

            expect((await getOrg(org.id)).plan).toBe("free");
        });

        it("returns 200 without touching the DB when no org matches the customer ID", async () => {
            // Customer exists in Stripe but org was deleted or not yet saved — should not crash
            mockConstructEvent.mockReturnValue(CHECKOUT_COMPLETED);
            stripeHas(RETRIEVED_SUBSCRIPTION);

            const res = await sendWebhook(app, CHECKOUT_COMPLETED);

            expect(res.status).toBe(200);
        });
    });

    // -----------------------------------------------------------------------
    describe("customer.subscription.deleted", () => {
        it("downgrades pro org to free when subscription is deleted", async () => {
            const org = await seedProOrg(CUSTOMER_DELETED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_DELETED);
            stripeHas(SUBSCRIPTION_DELETED.data.object);

            const res = await sendWebhook(app, SUBSCRIPTION_DELETED);

            expect(res.status).toBe(200);
            const updated = await getOrg(org.id);
            expect(updated.plan).toBe("free");
            expect(updated.stripeSubscriptionId).toBeNull();
        });

        it("preserves stripeCustomerId after downgrade so the org can resubscribe", async () => {
            // Clearing the customer ID would force a new Stripe customer on resubscription,
            // losing billing history. We only clear plan — customer ID must survive.
            const org = await seedProOrg(CUSTOMER_DELETED);
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_DELETED);
            stripeHas(SUBSCRIPTION_DELETED.data.object);

            await sendWebhook(app, SUBSCRIPTION_DELETED);

            expect((await getOrg(org.id)).stripeCustomerId).toBe(CUSTOMER_DELETED);
        });

        it("keeps the org paid when a stale deleted event arrives after the customer re-subscribed", async () => {
            // Stripe retries failed deliveries for days. Customer cancels →
            // the deleted event 500s on a DB blip → they re-subscribe → the
            // retry lands. Syncing from the event's subscription would downgrade
            // a paying customer; syncing from the customer's live state must not.
            const org = await seedProOrg(CUSTOMER_UPDATED);
            const oldCanceled = { ...SUBSCRIPTION_DELETED.data.object, customer: CUSTOMER_UPDATED };
            const newActive = { ...RETRIEVED_SUBSCRIPTION, id: "sub_new_after_resubscribe", created: oldCanceled.created + 1000 };
            mockConstructEvent.mockReturnValue({
                ...SUBSCRIPTION_DELETED,
                data: { ...SUBSCRIPTION_DELETED.data, object: oldCanceled },
            });
            stripeHas(oldCanceled, newActive);

            const res = await sendWebhook(app, SUBSCRIPTION_DELETED);

            expect(res.status).toBe(200);
            const updated = await getOrg(org.id);
            expect(updated.plan).toBe("pro");
            expect(updated.stripeSubscriptionId).toBe("sub_new_after_resubscribe");
        });

        it("prefers the newest paid subscription when Stripe reports more than one", async () => {
            const org = await seedFreeOrg(CUSTOMER_UPDATED);
            const older = { ...RETRIEVED_SUBSCRIPTION, id: "sub_older", created: 100 };
            const newer = { ...RETRIEVED_SUBSCRIPTION, id: "sub_newer", created: 200 };
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED);
            stripeHas(older, newer);

            await sendWebhook(app, SUBSCRIPTION_UPDATED);

            expect((await getOrg(org.id)).stripeSubscriptionId).toBe("sub_newer");
        });

        it("returns 200 without calling Stripe or touching the DB when no org matches the customer ID", async () => {
            mockConstructEvent.mockReturnValue(SUBSCRIPTION_DELETED);

            const res = await sendWebhook(app, SUBSCRIPTION_DELETED);

            expect(mockSubscriptionsList).not.toHaveBeenCalled();

            expect(res.status).toBe(200);
            expect(res.body.received).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    describe("error handling", () => {
        it("returns 400 when stripe-signature header is missing", async () => {
            const res = await request(app)
                .post("/v1/webhooks/stripe")
                .set("content-type", "application/json")
                .send("{}");

            expect(res.status).toBe(400);
        });

        it("returns 400 when signature verification fails", async () => {
            mockConstructEvent.mockImplementation(() => {
                throw new Error("Webhook signature verification failed.");
            });

            const res = await sendWebhook(app, {});

            expect(res.status).toBe(400);
        });

        it("returns 200 and ignores unhandled event types", async () => {
            mockConstructEvent.mockReturnValue({
                type: "payment_intent.succeeded",
                data: { object: {} },
            });

            const res = await sendWebhook(app, {});

            expect(res.status).toBe(200);
            expect(res.body.received).toBe(true);
        });
    });
});
