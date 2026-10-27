import { edition } from "../edition.js";

/**
 * Plan limits for each stored plan value.
 * Keep limits here — not in the database.
 * Changing limits is a product decision that belongs in code review.
 *
 * ## `free` is "no active plan", not a tier
 *
 * The cloud has no Free plan since 2026-10-11: the community edition is the
 * free tier, and every cloud plan starts with a card-required trial
 * (`cloud/billing/plans.ts` `TRIAL_DAYS`). The stored value `free` stays —
 * it is what `organizations.plan` holds for an org that has no subscription,
 * new or lapsed — and its limits are what such an org may still do: read
 * the dashboard, keep 30 days of history, connect **no** cluster. Every
 * write on such an org is refused with `403 plan_required` (`lib/plan-gate.ts`),
 * so `clusters: 0` is the belt to that gate's braces. The community edition
 * is unaffected: `getPlanLimits` answers the community plan there whatever
 * the column says.
 *
 * ## Why images are unlimited on every tier
 *
 * The old free tier was once capped at 25 unique images/month. A modest
 * production cluster runs 30–60, so a new user installed the agent, hit the
 * cap partway through the first sweep, and saw a *partial — therefore wrong*
 * — picture of their own cluster on day one. That does not read as
 * "limited", it reads as "broken", and it happens at precisely the moment
 * the product has to prove it works.
 *
 * The rule that replaced it: **never charge for completeness of the current
 * picture.** The whole pitch is "you can finally see all of it", so every tier
 * sees all of it. What is charged for is history, cluster count, and seats —
 * the axes below that still carry finite numbers.
 *
 * > [!IMPORTANT]
 * > Unique images per month is the closest proxy this system has to marginal
 * > cost (SBOM storage, and the matching work each one triggers). Removing the
 * > cap moves the cost ceiling onto `clusters`. If per-org cost becomes a
 * > problem, the lever to reach for is a rate limit on upload frequency — not
 * > a cap that silently truncates the inventory, which is the failure mode
 * > this change exists to remove. There is **no enforcement machinery left**:
 * > the counter columns and `incrementMonthlyUploads` were deleted once every
 * > tier went unlimited, so a future cap starts from the rate-limit design,
 * > not from resurrecting the counter. `uniqueImagesPerMonth` below is
 * > display config — the settings UI and pricing page render it as "Unlimited".
 *
 * ## What `historyDays` means — and what it must never mean
 *
 * `historyDays` is the plan's **history window**: how far back the org can
 * look, on every surface that looks backwards. Concretely it governs
 *
 * - the trend snapshots (`org_metrics_snapshots` / `cluster_metrics_snapshots`)
 *   — both the `?days` clamp on reads and the retention sweep that deletes
 *   older rows,
 * - the per-image scan-run history (`vulnerability_scan_runs`) — same pair,
 * - and the SBOM **archive**: how long an image nothing runs any more keeps
 *   its SBOM before the GC collects it (`imageGcRetentionDays`).
 *
 * It must never gate the *current picture*. One SBOM per image is the model
 * (ADR 0004/0006): the SBOM set is the live inventory, not a timeline, so an
 * SBOM is visible for as long as its image is deployed, on every tier — an
 * age check on `sboms.created_at` would hide a still-running image from
 * exactly the "are we affected?" question the product exists to answer. A
 * `historyDays` check on an SBOM read is a bug, not a feature.
 *
 * On `free` the window is also what a lapsed org's data lives on: history
 * older than 30 days is swept within a day of the plan ending, which is the
 * retention the marketing site's data-retention page states.
 *
 * ## `alerts`
 *
 * Whether the plan gets the critical & KEV alerts (`services/alert.service.ts`).
 * Both paid plans do, from the first day of the trial; an org without a plan
 * does not. The worker reads this on every pass, so a lapse silences alerts
 * and a new plan starts them, with no settings migration. Which *channels*
 * an alert has (webhook only, or email too) is the edition's decision, not
 * the plan's — `edition.alerting` in `src/edition.ts`.
 *
 * ## `community`
 *
 * The community edition's one plan:
 * no seat, cluster or image cap — the single cluster is `edition.multiCluster`,
 * not a limit here — and alerts on. Its history window is finite on purpose:
 * `historyDays` is real retention (the sweeps above delete past it), and a
 * self-hosted Postgres that never prunes trend snapshots, scan runs and
 * container history is an operational problem nobody asked for. A year
 * matches Pro. `getPlanLimits` returns this plan for *every* stored plan
 * value when `!edition.billing`, so a community database never has to carry
 * the word `community` in `organizations.plan` for the limits to apply.
 *
 * Mirrored by `client/src/components/organization-settings/constants.ts`
 * and gated by `scripts/check-cross-app-constants.mjs`.
 */
export const PLAN_LIMITS = {
    free: {
        // No plan, no cluster: the gate refuses the write anyway, and the
        // limit says the same thing to anything that only reads the table.
        clusters: 0,
        uniqueImagesPerMonth: Infinity,
        members: 1,
        // 30 days: what a lapsed org's history lives on, and the GC's
        // default floor, so an org without a plan needs no special casing.
        historyDays: 30,
        alerts: false,
    },
    pro: {
        clusters: 5,
        uniqueImagesPerMonth: Infinity,
        members: 10,
        historyDays: 365,
        alerts: true,
    },
    // Sold as "Business" (renamed from "Team" — display only). The key stays
    // `team` because it is a stored value on `organizations.plan` and the
    // Stripe price mapping; renaming it is a data migration, not a copy edit.
    team: {
        clusters: 15,
        uniqueImagesPerMonth: Infinity,
        members: 25,
        historyDays: 730,
        alerts: true,
    },
    community: {
        clusters: Infinity,
        uniqueImagesPerMonth: Infinity,
        members: Infinity,
        historyDays: 365,
        alerts: true,
    },
} as const;

export type PlanType = keyof typeof PLAN_LIMITS;

export type PlanLimits = (typeof PLAN_LIMITS)[PlanType];

/**
 * The limits that apply to an org on `plan`. In the community edition
 * every org is on the community plan whatever the column says; on the
 * cloud an unknown value is free (no plan), the safe direction for a limit.
 */
export function getPlanLimits(plan: string): PlanLimits {
    if (!edition.billing) return PLAN_LIMITS.community;
    return PLAN_LIMITS[plan as PlanType] ?? PLAN_LIMITS.free;
}

/** The stored plan values the alert worker delivers to, on the cloud. */
export const ALERT_PLANS: readonly PlanType[] = (Object.keys(PLAN_LIMITS) as PlanType[]).filter(
    (p) => PLAN_LIMITS[p].alerts,
);

/** Whether `plan` includes the critical & KEV alerts. Unknown plans are free. */
export function planHasAlerts(plan: string): boolean {
    return getPlanLimits(plan).alerts;
}
