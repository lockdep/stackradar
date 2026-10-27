// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type { Capabilities } from '@/lib/edition';

/**
 * The `code` the server refuses a write on an org without a plan with
 * (`server/src/lib/plan-gate.ts`). The toast matches on it.
 */
export const PLAN_REQUIRED_CODE = 'plan_required';

/**
 * What an organization's plan row means for the shell:
 *
 * - `active`: a plan (trialing, paying, or past due and being retried) — the
 *   app as usual. Also every org in the community edition, which has no
 *   plans.
 * - `never`: no plan and never had one — a new org. The shell shows the
 *   plan chooser and nothing else.
 * - `lapsed`: no plan now, but had one — a trial cancelled or a subscription
 *   ended. The dashboard stays readable behind a banner; every write is
 *   refused with `plan_required`.
 *
 * The stored plan `free` is "no plan" (`PLAN_LIMITS`), and the subscription
 * status is the memory: the webhook keeps the final status (`canceled`,
 * `unpaid`) on the row when the plan ends and leaves it empty for an org
 * that never started one. A checkout that was abandoned leaves both as
 * they were, so cancelling out of Stripe lands back on the chooser.
 */
export type PlanState = 'active' | 'never' | 'lapsed';

export function planState(
    org: { plan: string; stripeSubscriptionStatus?: string | null },
    edition: Pick<Capabilities, 'billing'>,
): PlanState {
    if (!edition.billing || org.plan !== 'free') return 'active';
    return org.stripeSubscriptionStatus ? 'lapsed' : 'never';
}
