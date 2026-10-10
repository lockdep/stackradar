// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { PlanType } from "../../config/plans.js";

/** The plans a checkout can buy — every stored plan but free, and never the community edition's. */
export type PaidPlan = Exclude<PlanType, "free" | "community">;

/**
 * How many subscriptions each paid plan sells at the **beta price** before
 * checkout moves new subscribers to the standard price (strategy doc
 * 2026-09-26 §3 P4, amended the same day from "first 20 Pro at $29" to
 * "the current beta price, capped": 10 Pro, 5 Business).
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
