// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { PLAN_NAMES } from '@/components/organization-settings/constants';
import type { PlanType } from '@/components/organization-settings/types';

export type BillingInterval = 'month' | 'year';

/** The plans a checkout can buy. */
export type PaidPlan = Exclude<PlanType, 'free' | 'community'>;

/**
 * How many subscriptions each paid plan sells at the beta price. Mirrors
 * `BETA_PRICE_SLOTS` in `server/src/cloud/billing/plans.ts`, which is what
 * the checkout enforces; this copy only lets the cards render the offer
 * before the live count (`GET /api/billing/pricing`) has arrived, or when
 * it never does.
 */
export const BETA_PRICE_SLOTS: Record<PaidPlan, number> = { pro: 10, team: 5 };

export interface PlanSlots {
    total: number;
    claimed: number;
}

export type BetaSlots = Record<PaidPlan, PlanSlots>;

/**
 * The two price books, in whole dollars. `beta` is what a subscription
 * created while the plan has a free slot pays, for as long as it stays
 * subscribed; `standard` is the pre-announced price after the slots (and at
 * the stable release). Annual is ten months' price. Both mirror the
 * marketing site's `lib/pricing.ts`, where the legal reasoning lives (a
 * future price is a pre-announcement, never a struck "was" price) — change
 * them there and here in the same commit. The Stripe prices behind them are
 * resolved by lookup key on the server (`cloud/billing/stripe-prices.ts`).
 */
export const PLAN_DETAILS = {
    free: {
        name: PLAN_NAMES.free,
        description: 'For individuals evaluating or running a single cluster.',
        price: '$0',
        period: '',
    },
    pro: {
        name: PLAN_NAMES.pro,
        description: 'For engineers running production workloads who need full visibility.',
        beta: { month: 59, year: 590 },
        standard: { month: 99, year: 990 },
    },
    // Sold as "Business"; the key stays `team` because it is the stored
    // `organizations.plan` value and the Stripe mapping (see server plans.ts).
    team: {
        name: PLAN_NAMES.team,
        description: 'For platform teams running fleets across environments.',
        beta: { month: 199, year: 1990 },
        standard: { month: 299, year: 2990 },
    },
} as const;

export const formatDollars = (amount: number) => `$${amount.toLocaleString('en-US')}`;

export interface PriceView {
    book: 'beta' | 'standard';
    /**
     * The hero amount, always per month: the monthly price, or on annual the
     * yearly total over twelve (to the dollar), with the real charge in
     * `billed` right under it. Mirrors the marketing site's `priceView`.
     */
    amount: number;
    /** The standard price on the same per-month basis, struck above a beta hero; null on the standard book. */
    strike: number | null;
    /** "Save $40/mo" on a monthly beta price, "Save 17%" on annual, "" otherwise. */
    saving: string;
    /** The yearly total on annual, "$590 /yr"; "" on monthly (the card keeps the row for alignment). */
    billed: string;
    /** The slot counter line under the price. */
    slotsLine: string;
}

/** A yearly total as a per-month figure, to the dollar. */
export const perMonth = (yearly: number) => Math.round(yearly / 12);

/** What annual saves against twelve months, as a whole percentage (10/12 → 17). */
export const annualSavingPct = (book: { month: number; year: number }) =>
    Math.round((1 - book.year / (book.month * 12)) * 100);

/** The largest annual saving across the paid plans — the toggle's "Save up to N%". */
export const MAX_ANNUAL_SAVING_PCT = Math.max(
    annualSavingPct(PLAN_DETAILS.pro.beta),
    annualSavingPct(PLAN_DETAILS.team.beta),
);

/**
 * What a paid plan's card shows for an interval, given the live slot count
 * (`null` while loading or if the count could not be fetched — the offer is
 * then shown without a count, never with a made-up one).
 *
 * The count says only which book is on sale; the server re-reads it at
 * checkout, so a stale card cannot buy a slot that is gone.
 */
export function priceView(plan: PaidPlan, interval: BillingInterval, slots: PlanSlots | null | undefined): PriceView {
    const details = PLAN_DETAILS[plan];
    const total = slots?.total ?? BETA_PRICE_SLOTS[plan];
    const claimed = slots?.claimed ?? 0;
    const book = slots && claimed >= total ? 'standard' : 'beta';
    const monthly = (b: 'beta' | 'standard') => (interval === 'year' ? perMonth(details[b].year) : details[b].month);
    const amount = monthly(book);
    const strike = book === 'beta' ? monthly('standard') : null;
    const saving =
        interval === 'year'
            ? `Save ${annualSavingPct(details[book])}%`
            : book === 'beta'
              ? `Save $${details.standard.month - details.beta.month}/mo`
              : '';
    const billed = interval === 'year' ? `${formatDollars(details[book].year)} /yr` : '';
    const left = total - claimed;
    const slotsLine =
        book === 'standard'
            ? 'No slots left at beta price'
            : `${left} ${left === 1 ? 'slot' : 'slots'} left at beta price`;
    return { book, amount, strike, saving, billed, slotsLine };
}
