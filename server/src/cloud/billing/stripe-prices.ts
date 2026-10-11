// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type Stripe from "stripe";
import { getStripe } from "./stripe.js";
import { AppError } from "../../middleware/error-handler.js";
import { createLogger } from "../../lib/logger.js";
import type { PaidPlan } from "./plans.js";

const log = createLogger("stripe-prices");

export type BillingInterval = "month" | "year";

/**
 * Beta or standard: which of the two price books a price belongs to. The
 * beta book is what `BETA_PRICE_SLOTS` caps; the standard book is what the
 * marketing site pre-announces as the price after the slots (and at the
 * stable release).
 */
export type PriceBook = "beta" | "standard";

/**
 * The price catalog, keyed by Stripe **lookup keys** rather than by eight
 * price-ID environment variables.
 *
 * The lookup key is set on the Price object in Stripe (`lookup_key`), so the
 * catalog is the same in every environment and adding a price is a Stripe
 * change, not a secret rotation and a rollout. The convention:
 *
 *     stackradar_<pro|team>_<monthly|annual>[_standard]
 *
 * — no suffix is the beta price, `_standard` the price after the beta
 * slots. Every price must sit under the plan's product, whose
 * `metadata.plan` ("pro" | "team") is what the webhook trusts to map a
 * subscription back to a tier (`billing.controller.ts` resolvePaidTier).
 *
 * Resolved lazily on first use and cached for the process lifetime: prices
 * are immutable in Stripe (a change is a new price with the key moved), so a
 * restart is the correct invalidation. A missing key fails the *checkout*
 * loudly, naming the key, instead of silently charging a different price.
 */
export function lookupKey(plan: PaidPlan, interval: BillingInterval, book: PriceBook): string {
    const period = interval === "year" ? "annual" : "monthly";
    return `stackradar_${plan}_${period}${book === "standard" ? "_standard" : ""}`;
}

const PLANS: readonly PaidPlan[] = ["pro", "team"];
const INTERVALS: readonly BillingInterval[] = ["month", "year"];
const BOOKS: readonly PriceBook[] = ["beta", "standard"];

export const ALL_LOOKUP_KEYS: readonly string[] = PLANS.flatMap((plan) =>
    INTERVALS.flatMap((interval) => BOOKS.map((book) => lookupKey(plan, interval, book))),
);

export interface CatalogPrice {
    id: string;
    plan: PaidPlan;
    interval: BillingInterval;
    book: PriceBook;
    /** Minor units, as Stripe stores them (5900 = $59.00). */
    unitAmount: number | null;
    currency: string;
}

export interface PriceCatalog {
    /** Every resolved price, by lookup key. */
    byKey: ReadonlyMap<string, CatalogPrice>;
    /** The same prices, by Stripe price ID — for the webhook's reverse lookup. */
    byId: ReadonlyMap<string, CatalogPrice>;
}

let cached: PriceCatalog | null = null;
let inflight: Promise<PriceCatalog> | null = null;

/** Parse a lookup key back into its coordinates; null for keys that are not ours. */
export function parseLookupKey(
    key: string | null | undefined,
): Omit<CatalogPrice, "id" | "unitAmount" | "currency"> | null {
    if (!key) return null;
    const m = /^stackradar_(pro|team)_(monthly|annual)(_standard)?$/.exec(key);
    if (!m) return null;
    return {
        plan: m[1] as PaidPlan,
        interval: m[2] === "annual" ? "year" : "month",
        book: m[3] ? "standard" : "beta",
    };
}

async function load(): Promise<PriceCatalog> {
    const stripe = getStripe();
    const byKey = new Map<string, CatalogPrice>();
    const byId = new Map<string, CatalogPrice>();
    // Stripe caps `lookup_keys` at 10 per call; we have 8.
    const list = await stripe.prices.list({
        lookup_keys: [...ALL_LOOKUP_KEYS],
        active: true,
        limit: ALL_LOOKUP_KEYS.length,
    });
    for (const price of list.data as Stripe.Price[]) {
        const coords = parseLookupKey(price.lookup_key);
        if (!coords) continue;
        const entry: CatalogPrice = {
            id: price.id,
            ...coords,
            unitAmount: price.unit_amount,
            currency: price.currency,
        };
        byKey.set(price.lookup_key!, entry);
        byId.set(price.id, entry);
    }
    const missing = ALL_LOOKUP_KEYS.filter((key) => !byKey.has(key));
    if (missing.length > 0) {
        // Partial catalogs are still cached: the beta monthly prices are the
        // ones that exist first, and a missing annual price should fail an
        // annual checkout, not every checkout.
        log.warn({ missing }, "Stripe price catalog is incomplete; checkouts needing these keys will fail");
    }
    return { byKey, byId };
}

/**
 * The catalog, loading it on first call. Concurrent first calls share one
 * request; a failed load is not cached, so the next checkout retries.
 */
export async function getPriceCatalog(): Promise<PriceCatalog> {
    if (cached) return cached;
    if (!inflight) {
        inflight = load()
            .then((catalog) => {
                cached = catalog;
                return catalog;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

/** The price for a plan, interval and book — or a 500 naming the missing lookup key. */
export async function requirePrice(plan: PaidPlan, interval: BillingInterval, book: PriceBook): Promise<CatalogPrice> {
    const key = lookupKey(plan, interval, book);
    const price = (await getPriceCatalog()).byKey.get(key);
    if (!price) {
        throw new AppError(500, `Stripe price is not configured: no active price with lookup key "${key}"`);
    }
    return price;
}

/**
 * Which paid plan a price ID belongs to, or null if the catalog does not
 * know it. Never throws: it is a fallback in the webhook path, which must
 * keep working when Stripe is slow.
 */
export async function planOfPriceId(priceId: string): Promise<PaidPlan | null> {
    try {
        return (await getPriceCatalog()).byId.get(priceId)?.plan ?? null;
    } catch (err) {
        log.warn({ err, priceId }, "Could not load the Stripe price catalog for a reverse lookup");
        return null;
    }
}

/** Test seam: forget the cached catalog. */
export function resetPriceCatalogForTests(): void {
    cached = null;
    inflight = null;
}
