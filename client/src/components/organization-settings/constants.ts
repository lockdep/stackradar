import type { Capabilities } from '@/lib/edition';
import type { PlanType } from './types';

export const roleVariants = {
    owner: 'attention',
    admin: 'accent',
    member: 'neutral',
} as const;

export const USAGE_WARNING_THRESHOLD = 0.8;

/**
 * Mirrors `server/src/config/plans.ts`, which is the authority — this copy
 * exists only so the settings UI can render limits without a round-trip.
 * Any change there has to be made here in the same commit, and on the
 * marketing site's `PricingSection`, or the three disagree in front of the
 * customer. `scripts/check-cross-app-constants.mjs` gates the numbers.
 *
 * `uniqueImagesPerMonth: Infinity` on every tier is deliberate: see the
 * rationale in the server file. `UsageBar` and `PlanCard.limitLabel` both
 * already special-case `Infinity`, rendering `∞` and "Unlimited" respectively.
 *
 * `historyDays` mirrors the server's history window (trend depth, scan-run
 * history, SBOM archive) and is what clamps the trend `DaysFilter`;
 * `retention` is its display string.
 *
 * `community` is the community edition's one plan: no caps (the single
 * cluster is `edition.multiCluster`, not a limit), a year of history. In
 * that edition every org is on it whatever the stored plan says — see
 * `effectivePlan`.
 */
export const PLAN_LIMITS = {
    // "No plan": the stored value for an org with no subscription, new or
    // lapsed. Read-only on the cloud, no cluster; 30 days is what its
    // history lives on after a plan ends.
    free: {
        clusters: 0,
        uniqueImagesPerMonth: Infinity,
        members: 1,
        sbomsStored: Infinity,
        historyDays: 30,
        retention: '30 days',
    },
    pro: {
        clusters: 5,
        uniqueImagesPerMonth: Infinity,
        members: 10,
        sbomsStored: Infinity,
        historyDays: 365,
        retention: '1 year',
    },
    team: {
        clusters: 15,
        uniqueImagesPerMonth: Infinity,
        members: 25,
        sbomsStored: Infinity,
        historyDays: 730,
        retention: '2 years',
    },
    community: {
        clusters: Infinity,
        uniqueImagesPerMonth: Infinity,
        members: Infinity,
        sbomsStored: Infinity,
        historyDays: 365,
        retention: '1 year',
    },
} as const satisfies Record<PlanType, unknown>;

/**
 * The plans as they are sold, not as they are stored: the top tier's key
 * is `team` but its name is "Business", and `free` — the stored value for
 * an org without a subscription — is "No plan", because the cloud has no
 * Free plan (the community edition is the free tier). The prices live with
 * the billing UI (`cloud/billing/pricing.ts`); the names are needed
 * everywhere a plan is mentioned.
 */
export const PLAN_NAMES: Record<PlanType, string> = {
    free: 'No plan',
    pro: 'Pro',
    team: 'Business',
    community: 'Community',
};

/**
 * The plan whose limits apply, given the edition: the community edition
 * has one plan for every org, and on the cloud an unknown stored value is
 * free (no plan) — matching the server's `getPlanLimits`.
 */
export function effectivePlan(plan: string | undefined, edition: Pick<Capabilities, 'billing'>): PlanType {
    if (!edition.billing) return 'community';
    return plan && plan in PLAN_LIMITS ? (plan as PlanType) : 'free';
}

export function planName(plan: string | undefined, edition: Pick<Capabilities, 'billing'>): string {
    return PLAN_NAMES[effectivePlan(plan, edition)];
}

/**
 * The plan's history window in days, for clamping history UI (the trend
 * chart's `DaysFilter`).
 */
export function getPlanHistoryDays(plan: string | undefined, edition: Pick<Capabilities, 'billing'>): number {
    return PLAN_LIMITS[effectivePlan(plan, edition)].historyDays;
}
