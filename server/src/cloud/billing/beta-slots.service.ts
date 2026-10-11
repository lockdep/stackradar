// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type Stripe from "stripe";
import { getStripe } from "./stripe.js";
import { createLogger } from "../../lib/logger.js";
import { BETA_PRICE_SLOTS, type PaidPlan } from "./plans.js";
import { getPriceCatalog, lookupKey, requirePrice, type BillingInterval, type CatalogPrice } from "./stripe-prices.js";

const log = createLogger("beta-slots");

export interface PlanSlots {
    /** Slots the plan sells at the beta price (`BETA_PRICE_SLOTS`). */
    total: number;
    /** Subscriptions created on the plan's beta prices so far, capped at `total`. */
    claimed: number;
}

export type BetaSlots = Record<PaidPlan, PlanSlots>;

/**
 * How long a count is served before Stripe is asked again. The webhook
 * invalidates on every subscription event, so this only bounds staleness
 * when a webhook is delayed — and bounds the Stripe traffic a public page
 * can cause.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Subscription statuses that do **not** consume a slot. `incomplete` is a
 * checkout whose first payment is still being authenticated (3-D Secure)
 * and `incomplete_expired` one that never was; every other status —
 * including `canceled` — began with a completed checkout, and that is the
 * event the slot counts.
 */
const NOT_CLAIMED: ReadonlySet<Stripe.Subscription.Status> = new Set(["incomplete", "incomplete_expired"]);

let cache: { value: BetaSlots; expiresAt: number } | null = null;
let inflight: Promise<BetaSlots> | null = null;

async function countOnPrice(price: CatalogPrice | undefined): Promise<number> {
    if (!price) return 0;
    const stripe = getStripe();
    let claimed = 0;
    // `price` filters on the subscription's *current* items, so a
    // subscription moved between plans in the portal moves its slot with
    // it. The caps are single digits; one page is plenty, and has_more is
    // treated as "full" rather than paginated.
    const list = await stripe.subscriptions.list({ price: price.id, status: "all", limit: 100 });
    for (const sub of list.data) {
        if (!NOT_CLAIMED.has(sub.status)) claimed += 1;
    }
    if (list.has_more) claimed = Math.max(claimed, BETA_PRICE_SLOTS[price.plan]);
    return claimed;
}

async function load(): Promise<BetaSlots> {
    const catalog = await getPriceCatalog();
    const result = {} as BetaSlots;
    for (const plan of Object.keys(BETA_PRICE_SLOTS) as PaidPlan[]) {
        const total = BETA_PRICE_SLOTS[plan];
        const [monthly, annual] = await Promise.all([
            countOnPrice(catalog.byKey.get(lookupKey(plan, "month", "beta"))),
            countOnPrice(catalog.byKey.get(lookupKey(plan, "year", "beta"))),
        ]);
        result[plan] = { total, claimed: Math.min(total, monthly + annual) };
    }
    return result;
}

/**
 * How many beta-price slots each paid plan has and how many are taken,
 * from Stripe — the subscriptions are the truth, not a counter of our own
 * that could disagree with what was actually sold.
 *
 * Cached for `CACHE_TTL_MS`; `invalidateBetaSlots()` from the webhook makes
 * a fresh checkout visible on the pricing page within seconds.
 */
export async function getBetaSlots(): Promise<BetaSlots> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.value;
    if (!inflight) {
        inflight = load()
            .then((value) => {
                cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
                return value;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

export function invalidateBetaSlots(): void {
    cache = null;
}

export interface PickedPrice {
    price: CatalogPrice;
    slots: PlanSlots;
}

/**
 * The price a new checkout for `plan` pays: the beta price while the plan
 * has a free slot, the standard price after.
 *
 * Read-then-act, not a lock: two checkouts completing in the same minute
 * can both take "the last" slot, and that is fine — one extra beta customer
 * is cheaper than a distributed lock in the checkout path. What it must
 * never do is the reverse: the count is re-read here (cache aside) rather
 * than trusted from the page, so a stale page cannot buy a slot that is
 * gone.
 */
export async function pickPrice(plan: PaidPlan, interval: BillingInterval): Promise<PickedPrice> {
    const slots = (await getBetaSlots())[plan];
    const book = slots.claimed < slots.total ? "beta" : "standard";
    const price = await requirePrice(plan, interval, book);
    if (book === "standard") {
        log.info({ plan, interval, slots }, "Beta slots exhausted; checkout uses the standard price");
    }
    return { price, slots };
}

/** Test seam. */
export function resetBetaSlotsForTests(): void {
    cache = null;
    inflight = null;
}
