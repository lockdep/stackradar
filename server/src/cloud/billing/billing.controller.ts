// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import { config } from "../../config/index.js";
import { organizationRepository, userRepository } from "../../repositories/index.js";
import type { Organization } from "../../db/schema/index.js";
import { AppError } from "../../middleware/error-handler.js";
import { assertAdminOrOwner, asAuthed } from "../../middleware/auth.js";
import { createLogger, createQueryTimer } from "../../lib/logger.js";
import { getStripe } from "./stripe.js";
import { planOfPriceId } from "./stripe-prices.js";
import { getBetaSlots, invalidateBetaSlots, pickPrice } from "./beta-slots.service.js";
import { createCheckoutSchema, createPortalSchema } from "./billing.schema.js";
import { TRIAL_DAYS } from "./plans.js";
import { classifyPlanTransition, emitPlanTransitions } from "./plan-transitions.js";

const log = createLogger("billing.controller");

/**
 * Static label Stripe uses to group this checkout flow's sessions in the
 * Dashboard. The random suffix distinguishes it from other integrations.
 */
const CHECKOUT_INTEGRATION_IDENTIFIER = "stackradar_upgrade_kqzmvwxr";

function validateRedirectUrl(url: string, field: string): void {
    // Exact origin match — a prefix check would accept
    // https://app.stackradar.io.evil.com.
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        throw new AppError(400, `Invalid ${field}: must be a StackRadar URL`);
    }
    if (origin !== new URL(config.appUrl).origin) {
        throw new AppError(400, `Invalid ${field}: must be a StackRadar URL`);
    }
}

/**
 * Subscription statuses that keep the org on its paid tier.
 *
 * `past_due` stays paid deliberately: Stripe's smart retries and dunning
 * emails run for days after a failed renewal, and downgrading immediately
 * would let the retention sweep start deleting history over a card hiccup.
 * Terminal failures arrive later as `canceled`/`unpaid` status updates or
 * as customer.subscription.deleted.
 */
const PAID_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set(["active", "trialing", "past_due"]);

/**
 * Statuses a subscription can only have if its checkout never completed:
 * `incomplete` is a first payment still being authenticated, and
 * `incomplete_expired` one that never was. Everything else began as a plan
 * the org had, so when none of them is paid any more the newest one's
 * status is kept on the org row as how that plan ended (`canceled`,
 * `unpaid`) — which is also what tells the client a `free` org has
 * **lapsed** rather than never started.
 */
const NEVER_STARTED: ReadonlySet<Stripe.Subscription.Status> = new Set(["incomplete", "incomplete_expired"]);

/**
 * Stripe caps expansion at 4 levels; `data.items.data.price.product` is 5
 * and is rejected with `property_expansion_max_depth`, so the product is
 * fetched separately in resolvePaidTier.
 */
const SUBSCRIPTION_LIST_EXPAND = ["data.items.data.price"];

/**
 * Which paid tier a subscription's price represents.
 *
 * The product's `metadata.plan` ("pro" | "team") is authoritative, so prices
 * added later (other currencies, grandfathered) map correctly without a
 * deploy. The price catalog (`lib/stripe-prices.ts`, by lookup key) is the
 * fallback for a product whose metadata is missing; an unrecognized price is
 * a config bug we log loudly rather than fail on — the customer did pay for
 * something.
 */
async function resolvePaidTier(subscription: Stripe.Subscription): Promise<"pro" | "team"> {
    const price = subscription.items.data[0]?.price;
    const product = await loadProduct(price?.product);
    if (product && !product.deleted) {
        const metaPlan = product.metadata?.plan;
        if (metaPlan === "pro" || metaPlan === "team") return metaPlan;
    }
    const fromCatalog = price?.id ? await planOfPriceId(price.id) : null;
    if (fromCatalog) return fromCatalog;
    log.warn(
        { subscriptionId: subscription.id, priceId: price?.id },
        "Unrecognized Stripe price on subscription; defaulting to pro",
    );
    return "pro";
}

/** Resolve a price's product, whether Stripe returned it expanded or as an ID. */
async function loadProduct(
    ref: Stripe.Price["product"] | undefined,
): Promise<Stripe.Product | Stripe.DeletedProduct | null> {
    if (!ref) return null;
    if (typeof ref === "object") return ref;
    try {
        return await getStripe().products.retrieve(ref);
    } catch (err) {
        log.warn({ err, productId: ref }, "Failed to load Stripe product; falling back to price IDs");
        return null;
    }
}

/**
 * The subscription that decides an org's plan: the paying one if any, else
 * nothing. Among several paid subscriptions (which checkout guards against,
 * but Stripe permits) the newest wins — it is the one the customer just
 * chose.
 */
function pickCurrentSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
    const paid = subscriptions.filter((sub) => PAID_STATUSES.has(sub.status)).sort((a, b) => b.created - a.created);
    return paid[0] ?? null;
}

/** How the org's last plan ended, when it has none now: the newest once-paid subscription's status. */
function endedStatus(subscriptions: Stripe.Subscription[]): Stripe.Subscription.Status | null {
    const ended = subscriptions.filter((sub) => !NEVER_STARTED.has(sub.status)).sort((a, b) => b.created - a.created);
    return ended[0]?.status ?? null;
}

/**
 * Recompute an org's plan from the customer's *current* subscriptions.
 *
 * Every webhook event lands here regardless of which subscription it names.
 * Stripe retries failed deliveries for days, so an event about a subscription
 * that was since replaced is a real case: the customer cancels, the `deleted`
 * event 500s on a DB blip, they re-subscribe, and the retry arrives — syncing
 * from the event's subscription would downgrade a paying customer. Deriving
 * from the customer's live state makes every event idempotent, order-proof,
 * and immune to being about the wrong subscription.
 *
 * The row being replaced is also the memory the trial events need: the
 * transitions (`plan-transitions.ts`) are read off "what the org row said"
 * against "what Stripe says now", written after the row, and never awaited.
 * A trial is a subscription in `trialing` status — during it
 * `current_period_end == trial_end`, so the stored period end is the date
 * the Billing tab shows as "trial ends".
 */
async function syncPlanForCustomer(customerId: string): Promise<void> {
    const org = await organizationRepository.getOrganizationByStripeCustomerId(customerId);
    if (!org) return;

    const list = await getStripe().subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
        expand: SUBSCRIPTION_LIST_EXPAND,
    });
    const subscription = pickCurrentSubscription(list.data);
    const transitions = classifyPlanTransition(org, subscription);

    const time = createQueryTimer(log, { orgId: org.id });
    if (subscription) {
        const plan = await resolvePaidTier(subscription);
        const periodEndUnix = subscription.items.data[0]?.current_period_end;
        await time(
            "updateOrganizationPlan",
            organizationRepository.updateOrganizationPlan(org.id, plan, {
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscription.id,
                stripeSubscriptionStatus: subscription.status,
                stripeCurrentPeriodEnd: periodEndUnix ? new Date(periodEndUnix * 1000) : null,
                stripeCancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
            }),
        );
        log.info(
            {
                orgId: org.id,
                plan,
                subscriptionId: subscription.id,
                subscriptionStatus: subscription.status,
                transitions,
            },
            "Plan updated from webhook",
        );
        emitPlanTransitions({ org, transitions, subscription, plan });
    } else {
        // stripeCustomerId is kept so the org can resubscribe under the same
        // customer (billing history, saved cards); only the subscription goes.
        // Its final status stays as the record that there *was* a plan —
        // the client tells a lapsed org from a new one by it.
        const ended = endedStatus(list.data);
        await time(
            "updateOrganizationPlan",
            organizationRepository.updateOrganizationPlan(org.id, "free", {
                stripeSubscriptionId: null,
                stripeSubscriptionStatus: ended,
                stripeCurrentPeriodEnd: null,
                stripeCancelAt: null,
            }),
        );
        log.info({ orgId: org.id, endedStatus: ended, transitions }, "Plan ended from webhook; org has no plan");
        emitPlanTransitions({ org, transitions, subscription: null, plan: "free" });
    }
}

function customerIdOf(object: { customer: string | Stripe.Customer | Stripe.DeletedCustomer | null }): string | null {
    if (!object.customer) return null;
    return typeof object.customer === "string" ? object.customer : object.customer.id;
}

/**
 * Cancel an org's subscription immediately, as part of deleting the org.
 *
 * Must run before the soft delete: the webhook path looks orgs up by Stripe
 * customer ID *excluding* soft-deleted rows, so once `deleted_at` is set no
 * event could ever stop the billing. A failed cancellation therefore aborts
 * the deletion — except when Stripe reports there is nothing left to cancel
 * (subscription gone or already canceled), which is the state we wanted.
 */
export async function cancelSubscriptionForOrgDeletion(org: Organization): Promise<void> {
    if (!org.stripeSubscriptionId) return;
    try {
        await getStripe().subscriptions.cancel(org.stripeSubscriptionId);
        log.info(
            { orgId: org.id, subscriptionId: org.stripeSubscriptionId },
            "Stripe subscription canceled for org deletion",
        );
    } catch (error) {
        if (error instanceof Stripe.errors.StripeInvalidRequestError) {
            // "No such subscription" / "already canceled" — nothing to stop.
            log.warn(
                { orgId: org.id, subscriptionId: org.stripeSubscriptionId, err: error },
                "Subscription not cancelable during org deletion; proceeding",
            );
            return;
        }
        throw error;
    }
}

export const billingController = {
    /**
     * Create a Stripe Checkout session that starts a plan (Pro or Business)
     * on an org without one. Returns a URL the client redirects to, and
     * whether the session carries the free trial.
     *
     * Every plan starts with a `TRIAL_DAYS` free trial unless the acting
     * user has had one (`users.trial_consumed_at`): the card is collected at
     * checkout (`payment_method_collection: "always"`) and nothing is charged
     * until the trial ends; a trial whose card went missing is cancelled
     * rather than converted. A repeat user is charged from day one, and the
     * response says so (`trial: false`) so the chooser can too.
     *
     * Changes between paid plans go through the billing portal, not checkout —
     * checkout would create a second subscription alongside the existing one.
     * @route POST /api/billing/checkout
     */
    async createCheckout(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            // The route is `requireInternal`, so this is a person, never a key.
            const userId = auth.userId;
            if (!userId) throw new AppError(403, "This endpoint is not available to API keys");
            const { plan: requestedPlan, interval, successUrl, cancelUrl } = createCheckoutSchema.parse(req.body);
            // Billing changes the whole org's plan — admin/owner only.
            await assertAdminOrOwner(req, orgId);
            const time = createQueryTimer(log, { orgId });
            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(orgId));
            if (!org) throw new AppError(404, "Organization not found");

            if (org.plan !== "free") {
                throw new AppError(
                    400,
                    "Organization already has a paid plan. Manage plan changes in the billing portal.",
                );
            }

            // Beta price while the plan has a slot left, standard price after
            // (`services/beta-slots.service.ts`). Decided here, never from
            // anything the client sends: the page shows the count, the
            // server enforces it.
            const { price, slots } = await pickPrice(requestedPlan, interval);

            // One trial per person, decided by who is clicking, not by the
            // org: the org is new (or lapsed), the person may not be.
            const actor = await time("getUserById", userRepository.getUserById(userId));
            const trial = actor?.trialConsumedAt == null;

            const stripe = getStripe();

            validateRedirectUrl(successUrl, "successUrl");
            validateRedirectUrl(cancelUrl, "cancelUrl");

            // Reuse existing Stripe customer or create a new one
            let customerId = org.stripeCustomerId ?? undefined;
            if (customerId) {
                // The org row may still read "free" while the checkout webhook
                // is in flight, or two tabs may race — never create a second
                // subscription on the same customer.
                const existing = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
                if (existing.data.some((sub) => PAID_STATUSES.has(sub.status))) {
                    throw new AppError(
                        400,
                        "Organization already has an active subscription. Manage plan changes in the billing portal.",
                    );
                }
            } else {
                // Created without an email on purpose: the billing email is
                // the customer's to choose. Checkout collects one and sets it
                // on the customer (Stripe does this whenever the customer has
                // no email), instead of us copying the login email of whoever
                // happened to click upgrade.
                const customer = await stripe.customers.create({
                    name: org.name,
                });
                customerId = customer.id;
                await time(
                    "saveStripeCustomerId",
                    organizationRepository.updateOrganizationPlan(orgId, org.plan, { stripeCustomerId: customerId }),
                );
            }

            const session = await stripe.checkout.sessions.create({
                customer: customerId,
                mode: "subscription",
                line_items: [{ price: price.id, quantity: 1 }],
                // Redundant org linkage for Dashboard debugging and support;
                // the customer-ID lookup remains the path the webhook uses.
                // `priceBook` records whether this was a beta slot, so the
                // Dashboard can answer "who got the beta price" without
                // decoding price IDs.
                // `userId` names who checked out, so the webhook can stamp
                // *their* `trial_consumed_at` when the trial starts.
                client_reference_id: orgId,
                subscription_data: {
                    metadata: { orgId, priceBook: price.book, userId },
                    ...(trial
                        ? {
                              trial_period_days: TRIAL_DAYS,
                              trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
                          }
                        : {}),
                },
                // The card is taken now, trial or not; Stripe would otherwise
                // let a trial start without one, and the promise is "card
                // required, nothing charged until it ends".
                payment_method_collection: "always",
                integration_identifier: CHECKOUT_INTEGRATION_IDENTIFIER,
                success_url: successUrl,
                cancel_url: cancelUrl,
            });

            log.info(
                { orgId, sessionId: session.id, plan: requestedPlan, interval, priceBook: price.book, slots, trial },
                "Stripe checkout session created",
            );
            res.json({ url: session.url, trial });
        } catch (error) {
            next(error);
        }
    },

    /**
     * The beta-price slot counts, for the pricing page (public, `/v1/pricing`)
     * and the app's Billing tab (`/api/billing/pricing`). The prices
     * themselves are not here on purpose: they are copy, kept in the two
     * front-ends next to the words that explain them; this endpoint carries
     * only the number that changes.
     *
     * Unauthenticated on `/v1`, so it must stay cheap: the service caches the
     * count, and the response is cacheable for the same minute. A Stripe
     * outage answers 503 and the pages fall back to the offer without a
     * count, never to a made-up one.
     *
     * The in-app route knows who is asking and adds `trialEligible`: whether
     * a checkout by this person would carry the free trial
     * (`users.trial_consumed_at`), so the plan chooser can say "billing
     * starts today" before the click rather than after it. Per-person, so
     * that response is `private`.
     * @route GET /v1/pricing — in-cluster only, not on the API ingress
     * @route GET /api/billing/pricing
     */
    async pricing(req: Request, res: Response, next: NextFunction) {
        try {
            const betaSlots = await getBetaSlots();
            if (req.auth?.type === "internal") {
                const actor = await userRepository.getUserById(req.auth.userId);
                res.set("Cache-Control", "private, max-age=60");
                res.json({ betaSlots, trialEligible: actor?.trialConsumedAt == null });
                return;
            }
            res.set("Cache-Control", "public, max-age=60");
            res.json({ betaSlots });
        } catch (error) {
            log.warn({ err: error }, "Could not read the beta slot counts from Stripe");
            next(error instanceof AppError ? error : new AppError(503, "Pricing is temporarily unavailable"));
        }
    },

    /**
     * Create a Stripe Customer Portal session to manage/cancel subscription.
     * Returns a URL the client redirects to.
     * @route POST /api/billing/portal
     */
    async createPortal(req: Request, res: Response, next: NextFunction) {
        try {
            const { auth } = asAuthed(req);
            const orgId = auth.orgId;
            // Billing changes the whole org's plan — admin/owner only.
            await assertAdminOrOwner(req, orgId);
            const time = createQueryTimer(log, { orgId });
            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(orgId));
            if (!org) throw new AppError(404, "Organization not found");

            if (!org.stripeCustomerId) {
                throw new AppError(400, "No billing account found. Upgrade to a paid plan first.");
            }

            const { returnUrl } = createPortalSchema.parse(req.body);
            validateRedirectUrl(returnUrl, "returnUrl");

            const stripe = getStripe();
            const session = await stripe.billingPortal.sessions.create({
                customer: org.stripeCustomerId,
                return_url: returnUrl,
            });

            log.info({ orgId }, "Stripe portal session created");
            res.json({ url: session.url });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Stripe webhook — keeps org plan in sync with Stripe subscription state.
     * @route POST /v1/webhooks/stripe
     * Requires raw body (registered before express.json middleware).
     */
    async webhook(req: Request, res: Response, next: NextFunction) {
        try {
            const sig = req.headers["stripe-signature"];
            if (!sig || !config.stripe.webhookSecret) {
                throw new AppError(400, "Missing Stripe signature");
            }

            const stripe = getStripe();
            let event: Stripe.Event;

            try {
                event = stripe.webhooks.constructEvent(req.body as Buffer, sig, config.stripe.webhookSecret);
            } catch {
                throw new AppError(400, "Invalid Stripe webhook signature");
            }

            // Every handled event resolves to "re-derive this customer's plan
            // from Stripe" — see syncPlanForCustomer for why the event's own
            // payload (and even the subscription it names) is never trusted.
            // Any of them can also mean a beta slot was just taken, so the
            // cached count is dropped before the customer's plan is synced.
            switch (event.type) {
                // Fired once when a user completes the Stripe-hosted checkout page and payment succeeds.
                // Primary upgrade path: user clicks "Upgrade to Pro" → redirected to Stripe → lands here.
                case "checkout.session.completed": {
                    const session = event.data.object as Stripe.Checkout.Session;
                    if (!session.subscription) break;
                    invalidateBetaSlots();
                    const customerId = customerIdOf(session);
                    if (customerId) await syncPlanForCustomer(customerId);
                    break;
                }

                // `updated` fires on any change to an existing subscription: trial → active,
                // payment failure (past_due), scheduled cancellation (cancel_at set, status
                // still "active"), plan change via the portal, etc. It also fires right after
                // checkout.session.completed, so upgrades are handled twice — idempotent.
                // `deleted` fires when a subscription ends: cancel_at reached, immediate
                // cancellation via portal, or payment retries exhausted.
                // `trial_will_end` fires three days before a trial converts (and when a
                // trial is cancelled with less than that left); it carries nothing the
                // sync does not re-read, but it is one more delivery near the moment that
                // matters most, in case the `updated` event is delayed.
                case "customer.subscription.updated":
                case "customer.subscription.deleted":
                case "customer.subscription.trial_will_end": {
                    const subscription = event.data.object as Stripe.Subscription;
                    invalidateBetaSlots();
                    const customerId = customerIdOf(subscription);
                    if (customerId) await syncPlanForCustomer(customerId);
                    break;
                }

                default:
                    // Ignore other events
                    break;
            }

            res.json({ received: true });
        } catch (error) {
            next(error);
        }
    },
};
