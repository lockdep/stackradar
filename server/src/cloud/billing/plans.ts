// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { PlanType } from "../../config/plans.js";

/** The plans a checkout can buy — every stored plan but free, and never the community edition's. */
export type PaidPlan = Exclude<PlanType, "free" | "community">;

/**
 * How long the free trial every cloud plan starts with lasts. The trial
 * **is** a Stripe subscription in `trialing` status — there is no trial
 * state or clock of our own — created by the Checkout session with
 * `trial_period_days` and a card collected up front (`billing.controller.ts`
 * `createCheckout`). Nothing is charged until it ends; cancelling before
 * then (from the billing portal) ends it unpaid. One trial per person:
 * `users.trial_consumed_at` is stamped when a subscription of theirs first
 * trials, and a later checkout by the same user carries no trial period.
 *
 * Mirrored for display by `client/src/cloud/billing/pricing.ts` (gated by
 * `scripts/check-cross-app-constants.mjs`) and, by hand, by the marketing
 * site's `lib/pricing.ts` — change all three in the same commit.
 */
export const TRIAL_DAYS = 14;

/**
 * How many subscriptions each paid plan sells at the **beta price** before
 * checkout moves new subscribers to the standard price: 10 Pro, 5 Business
 * at the current beta price, capped.
 *
 * A slot is a subscription created on one of the plan's beta prices
 * (`stripe-prices.ts`), monthly or annual, in any status Stripe reached
 * through a completed checkout — cancelling does not hand the slot back,
 * because "the first ten" is a statement about who came first, and a counter
 * that goes back up looks broken. Both the public pricing page and the
 * checkout read the same count (`beta-slots.service.ts`), so the page can
 * never promise a price the checkout will not honour.
 *
 * Raising a number here reopens the offer; the standard-price subscriptions
 * already sold stay where they are. Mirrored for display by
 * `client/src/cloud/billing/pricing.ts`.
 */
export const BETA_PRICE_SLOTS: Readonly<Record<PaidPlan, number>> = {
    pro: 10,
    team: 5,
};
