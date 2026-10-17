// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useOrganization } from '@/components/providers';
import { useSearchParams, useRouter } from 'next/navigation';
import { RefreshCw, CreditCard, Info, Clock } from 'lucide-react';
import { Button, LoadingBlock, Spinner } from '@/components/ui';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';
import { PLAN_LIMITS, USAGE_WARNING_THRESHOLD } from '@/components/organization-settings/constants';
import type { Usage } from '@/components/organization-settings/types';
import { PLAN_DETAILS, BETA_PRICE_SLOTS, type BetaSlots, type BillingInterval } from './pricing';
import { UsageBar } from './UsageBar';
import { PlanCard } from './PlanCard';
import { BillingIntervalToggle } from './BillingIntervalToggle';

/** The plans the tab sells and compares: the three the cloud has. */
type PlanType = keyof typeof PLAN_DETAILS;

function isBillingPlan(plan: string): plan is PlanType {
    return plan in PLAN_DETAILS;
}

interface BillingTabProps {
    orgId: string;
    /**
     * The live demo: the plan card and usage stay, every checkout and
     * portal button goes — the server refuses both for the demo org, and a
     * Stripe session for a shared visitor account would be worse than a 403.
     */
    readOnly?: boolean;
    /** The stored plan; anything the cloud does not sell (unknown, `community`) renders as free. */
    currentPlan: string;
    subscriptionStatus?: string | null;
    currentPeriodEnd?: string | null;
    cancelAt?: string | null;
}

/**
 * How long to keep asking the server whether the checkout webhook has landed.
 * Stripe usually delivers within a couple of seconds; 30s covers a slow retry
 * without leaving a spinner up forever.
 */
const PLAN_CONFIRM_INTERVAL_MS = 2000;
const PLAN_CONFIRM_MAX_ATTEMPTS = 15;

export function BillingTab({
    orgId,
    readOnly = false,
    currentPlan: storedPlan,
    subscriptionStatus,
    currentPeriodEnd,
    cancelAt,
}: BillingTabProps) {
    const currentPlan: PlanType = isBillingPlan(storedPlan) ? storedPlan : 'free';
    const searchParams = useSearchParams();
    const router = useRouter();
    const { updateOrganization } = useOrganization();
    /* The usage read for the org the tab is showing, keyed by org: a switch
       while mounted reads as loading, never as the previous org's numbers. */
    const [loadedUsage, setLoadedUsage] = useState<{ orgId: string; usage: Usage | null } | null>(null);
    const usage = loadedUsage && loadedUsage.orgId === orgId ? loadedUsage.usage : null;
    const isLoading = loadedUsage === null || loadedUsage.orgId !== orgId;
    const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
    const [isPortalLoading, setIsPortalLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [interval, setInterval_] = useState<BillingInterval>('month');
    // The live beta-slot counts. Null until fetched — and if the fetch
    // fails, which the cards render as the offer without a count; the
    // server decides the price at checkout either way.
    const [betaSlots, setBetaSlots] = useState<BetaSlots | null>(null);
    useEffect(() => {
        let cancelled = false;
        apiFetch<{ betaSlots?: BetaSlots | null }>('/api/billing/pricing')
            .then((body) => body.betaSlots ?? null)
            .catch(() => null)
            .then((slots) => {
                if (!cancelled) setBetaSlots(slots);
            });
        return () => {
            cancelled = true;
        };
    }, []);
    const [billingStatus, setBillingStatus] = useState<'success' | 'cancelled' | null>(() => {
        const v = searchParams.get('billing');
        return v === 'success' || v === 'cancelled' ? v : null;
    });

    useEffect(() => {
        if (!billingStatus) return;
        const params = new URLSearchParams(searchParams.toString());
        params.delete('billing');
        router.replace(`/org-settings?${params.toString()}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount: `billing` was read into state above and is stripped exactly once; re-running on the `searchParams` change this replace itself causes would be a loop.
    }, []);

    // Stripe redirects back before its webhook has told us about the new
    // subscription, so on `billing=success` the org can still read "free" for
    // a few seconds. Poll until the plan flips rather than claim an upgrade
    // the page doesn't yet show; give up quietly after the window.
    const [planConfirmTimedOut, setPlanConfirmTimedOut] = useState(false);
    const isConfirmingPlan = billingStatus === 'success' && currentPlan === 'free' && !planConfirmTimedOut;
    useEffect(() => {
        if (!isConfirmingPlan) return;
        let attempts = 0;
        let cancelled = false;
        const timer = setInterval(async () => {
            attempts += 1;
            try {
                const { organization } = await apiFetch<{
                    organization?: {
                        plan?: string;
                        stripeSubscriptionStatus?: string | null;
                        stripeCurrentPeriodEnd?: string | null;
                        stripeCancelAt?: string | null;
                    };
                }>(`/api/organizations/${orgId}`);
                if (!cancelled && organization?.plan && organization.plan !== 'free') {
                    updateOrganization({
                        id: orgId,
                        plan: organization.plan,
                        stripeSubscriptionStatus: organization.stripeSubscriptionStatus ?? null,
                        stripeCurrentPeriodEnd: organization.stripeCurrentPeriodEnd ?? null,
                        stripeCancelAt: organization.stripeCancelAt ?? null,
                    });
                    return;
                }
            } catch {
                // transient — try again on the next tick
            }
            if (attempts >= PLAN_CONFIRM_MAX_ATTEMPTS && !cancelled) {
                clearInterval(timer);
                setPlanConfirmTimedOut(true);
            }
        }, PLAN_CONFIRM_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [isConfirmingPlan, orgId, updateOrganization]);

    const limits = PLAN_LIMITS[currentPlan];

    const fmt = (iso: string | null | undefined) =>
        iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(iso)) : null;

    const formattedCancelAt = useMemo(() => fmt(cancelAt), [cancelAt]);
    const formattedPeriodEnd = useMemo(() => fmt(currentPeriodEnd), [currentPeriodEnd]);

    const isPaymentFailing = subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid';

    const loadUsage = useCallback(
        () =>
            apiFetch<{ usage: Usage }>(`/api/organizations/${orgId}/usage`).then(
                (data) => setLoadedUsage({ orgId, usage: data.usage }),
                (err: unknown) => {
                    setLoadedUsage({ orgId, usage: null });
                    setError(
                        err instanceof ApiError && err.status > 0
                            ? 'Failed to load usage data'
                            : errorMessage(err, 'Failed to load usage'),
                    );
                },
            ),
        [orgId],
    );

    useEffect(() => {
        void loadUsage();
    }, [loadUsage]);

    /* The refresh button: back to loading, then the same read. */
    const fetchUsage = () => {
        setLoadedUsage(null);
        setError(null);
        void loadUsage();
    };

    const handleManageBilling = async () => {
        setIsPortalLoading(true);
        try {
            const returnUrl = `${window.location.origin}/org-settings?tab=billing`;
            const { url } = await apiFetch<{ url: string }>('/api/billing/portal', {
                method: 'POST',
                json: { returnUrl },
            });
            window.location.assign(url);
        } catch {
            setIsPortalLoading(false);
            setError('Failed to open billing portal');
        }
    };

    const handlePlanSelect = async (targetPlan: PlanType) => {
        const planOrder: PlanType[] = ['free', 'pro', 'team'];
        const isDowngrade = planOrder.indexOf(targetPlan) < planOrder.indexOf(currentPlan);

        if (isDowngrade) {
            if (
                !window.confirm(
                    `Downgrade to ${PLAN_DETAILS[targetPlan].name}? You can change your subscription in the billing portal.`,
                )
            )
                return;
            await handleManageBilling();
            return;
        }

        // Checkout only creates the first subscription; changes between paid
        // plans (e.g. Pro → Team) are made in the billing portal.
        if (currentPlan !== 'free') {
            await handleManageBilling();
            return;
        }

        setIsCheckoutLoading(true);
        try {
            const base = `${window.location.origin}/org-settings?tab=billing`;
            const { url } = await apiFetch<{ url: string }>('/api/billing/checkout', {
                method: 'POST',
                json: {
                    plan: targetPlan,
                    interval,
                    successUrl: `${base}&billing=success`,
                    cancelUrl: `${base}&billing=cancelled`,
                },
            });
            window.location.assign(url);
        } catch (err) {
            setIsCheckoutLoading(false);
            /* The page's wording, as before: a refusal is "could not create", an unreachable server "could not start". */
            setError(
                err instanceof ApiError && err.status > 0
                    ? 'Failed to create checkout session'
                    : errorMessage(err, 'Failed to start checkout'),
            );
        }
    };

    if (isLoading) {
        return <LoadingBlock label="Loading billing..." className="py-12" />;
    }

    const planOrder: PlanType[] = ['free', 'pro', 'team'];
    const currentPlanIndex = planOrder.indexOf(currentPlan);
    const nextPlan = planOrder[currentPlanIndex + 1];
    // Paid orgs change plans in the Stripe portal rather than a checkout page,
    // so don't promise an "upgrade" flow the button won't deliver.
    const viaPortal = currentPlan !== 'free';
    const upgradeLabel = (plan: PlanType) => (viaPortal ? 'Change plan' : `Upgrade to ${PLAN_DETAILS[plan].name}`);
    // Over-limit happens after a downgrade: nothing is taken away — existing
    // clusters and members keep working — but new ones are blocked until the
    // org is back under its limits or upgrades. Warn, don't enforce.
    const isOverLimits = usage != null && (usage.clusters > limits.clusters || usage.members > limits.members);
    const isApproachingLimits =
        !isOverLimits &&
        usage != null &&
        (usage.clusters >= limits.clusters * USAGE_WARNING_THRESHOLD ||
            usage.uniqueImagesThisMonth >= limits.uniqueImagesPerMonth * USAGE_WARNING_THRESHOLD ||
            usage.members >= limits.members * USAGE_WARNING_THRESHOLD);

    return (
        <div className="space-y-8">
            {billingStatus === 'success' && isConfirmingPlan && (
                <div
                    role="status"
                    className="flex items-center justify-between rounded-md bg-accent-subtle border border-accent-muted px-4 py-3 text-sm text-ink-secondary"
                >
                    <span className="flex items-center gap-2">
                        <Spinner size="sm" className="text-current" />
                        Payment received — confirming your new plan…
                    </span>
                </div>
            )}
            {billingStatus === 'success' && !isConfirmingPlan && !planConfirmTimedOut && (
                <div
                    role="alert"
                    className="flex items-center justify-between rounded-md bg-success-subtle border border-success-muted px-4 py-3 text-sm text-success"
                >
                    <span>Your plan has been upgraded. Welcome aboard!</span>
                    <button
                        onClick={() => setBillingStatus(null)}
                        aria-label="Dismiss"
                        className="ml-4 text-success hover:underline cursor-pointer"
                    >
                        ✕
                    </button>
                </div>
            )}
            {billingStatus === 'success' && planConfirmTimedOut && (
                <div
                    role="alert"
                    className="flex items-center justify-between rounded-md bg-attention-subtle border border-attention-muted px-4 py-3 text-sm text-attention"
                >
                    <span>Payment received. Your plan is still being activated — refresh this page in a minute.</span>
                    <button
                        onClick={() => setBillingStatus(null)}
                        aria-label="Dismiss"
                        className="ml-4 text-attention hover:underline cursor-pointer"
                    >
                        ✕
                    </button>
                </div>
            )}
            {billingStatus === 'cancelled' && (
                <div
                    role="alert"
                    className="flex items-center justify-between rounded-md bg-accent-subtle border border-accent-muted px-4 py-3 text-sm text-ink-secondary"
                >
                    <span className="flex items-center gap-2">
                        <Info className="size-4 shrink-0" />
                        Checkout was cancelled. You have not been charged.
                    </span>
                    <button
                        onClick={() => setBillingStatus(null)}
                        aria-label="Dismiss"
                        className="ml-4 text-ink-muted hover:text-ink-secondary cursor-pointer"
                    >
                        ✕
                    </button>
                </div>
            )}
            {isPaymentFailing && (
                <div
                    role="alert"
                    className="flex items-center gap-3 rounded-md bg-danger-subtle border border-danger-muted px-4 py-3 text-sm text-danger"
                >
                    <Info className="size-4 shrink-0" />
                    <span>
                        {subscriptionStatus === 'unpaid' ? (
                            <>
                                All payment retries exhausted — your {PLAN_DETAILS[currentPlan].name} access is at
                                risk.{' '}
                            </>
                        ) : (
                            <>Payment failed — Stripe will retry automatically. </>
                        )}
                        {!readOnly && (
                            <button onClick={handleManageBilling} className="underline font-medium cursor-pointer">
                                Update payment method
                            </button>
                        )}
                    </span>
                </div>
            )}
            {formattedCancelAt && (
                <div
                    role="status"
                    className="flex items-center gap-3 rounded-md bg-attention-subtle border border-attention-muted px-4 py-3 text-sm text-attention"
                >
                    <Clock className="size-4 shrink-0" />
                    <span>
                        Your {PLAN_DETAILS[currentPlan].name} plan is active until <strong>{formattedCancelAt}</strong>.
                        After that your account will move to the Free plan.
                    </span>
                </div>
            )}
            {/* Current Usage Section */}
            <div className="rounded-md bg-surface-raised border border-edge p-6 shadow-resting">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h3 className="text-lg font-medium text-ink">Current Usage</h3>
                        <p className="text-sm text-ink-muted">
                            You&apos;re on the{' '}
                            <span className="font-medium text-ink">{PLAN_DETAILS[currentPlan].name}</span> plan
                        </p>
                    </div>
                    <button
                        onClick={fetchUsage}
                        className="p-2 text-ink-faint hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors cursor-pointer"
                        aria-label="Refresh usage"
                    >
                        <RefreshCw className="size-5" />
                    </button>
                </div>

                {error && (
                    <div role="alert" className="bg-danger-subtle border border-danger-muted rounded-md p-4 mb-6">
                        <p className="text-sm text-danger">{error}</p>
                    </div>
                )}

                {usage && (
                    <div className="grid gap-6 sm:grid-cols-2">
                        <UsageBar label="Clusters" current={usage.clusters} limit={limits.clusters} />
                        <UsageBar
                            label="Unique Images This Month"
                            current={usage.uniqueImagesThisMonth}
                            limit={limits.uniqueImagesPerMonth}
                        />
                        <UsageBar label="Team Members" current={usage.members} limit={limits.members} />
                        <UsageBar label="SBOMs Stored" current={usage.sbomsStored} limit={limits.sbomsStored} />
                    </div>
                )}

                {isOverLimits && (
                    <div className="mt-6 bg-attention-subtle border border-attention-muted rounded-md p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                        <p className="text-sm text-attention">
                            <strong>You&apos;re over the limits of the {PLAN_DETAILS[currentPlan].name} plan.</strong>{' '}
                            Everything you have keeps working, but you can&apos;t add new clusters or members until
                            you&apos;re back under the limits
                            {nextPlan ? ` — or upgrade to ${PLAN_DETAILS[nextPlan].name}` : ''}.
                        </p>
                        {nextPlan && !readOnly && (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => handlePlanSelect(nextPlan)}
                                disabled={isPortalLoading}
                                loading={isCheckoutLoading}
                                className="shrink-0"
                            >
                                {upgradeLabel(nextPlan)}
                            </Button>
                        )}
                    </div>
                )}

                {isApproachingLimits && (
                    <div className="mt-6 bg-attention-subtle border border-attention-muted rounded-md p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                        <p className="text-sm text-attention">
                            <strong>You&apos;re approaching your plan limits.</strong>
                            {nextPlan &&
                                ` Upgrade to ${PLAN_DETAILS[nextPlan].name} for more clusters, images, and team members.`}
                        </p>
                        {nextPlan && !readOnly && (
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => handlePlanSelect(nextPlan)}
                                disabled={isPortalLoading}
                                loading={isCheckoutLoading}
                                className="shrink-0"
                            >
                                {upgradeLabel(nextPlan)}
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {/* Plan Comparison Section */}
            <div>
                <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <h3 className="text-lg font-medium text-ink mb-2">Available Plans</h3>
                        <p className="text-sm text-ink-muted">Choose the plan that best fits your team&apos;s needs.</p>
                    </div>
                    {!readOnly && !viaPortal && <BillingIntervalToggle value={interval} onChange={setInterval_} />}
                </div>

                <div className="grid gap-6 md:grid-cols-3">
                    {planOrder.map((plan, index) => {
                        const isUpgrade = index > currentPlanIndex;
                        return (
                            <PlanCard
                                key={plan}
                                plan={plan}
                                interval={interval}
                                slots={plan === 'free' ? null : (betaSlots?.[plan] ?? null)}
                                isCurrentPlan={plan === currentPlan}
                                onSelect={handlePlanSelect}
                                isUpgrade={isUpgrade}
                                isRecommended={plan === nextPlan}
                                viaPortal={viaPortal}
                                readOnly={readOnly}
                                isLoading={isUpgrade ? isCheckoutLoading : isPortalLoading}
                                isAnyLoading={isCheckoutLoading || isPortalLoading}
                            />
                        );
                    })}
                </div>

                {/* The cards carry the numbers, this carries the reason — a
                    compact version of the landing page's beta-pricing note,
                    with the slot caps and standard prices read from the
                    constants so the two can't drift apart. */}
                <div className="mt-6 rounded-md bg-accent-subtle/60 px-4 py-3 ring-1 ring-accent-muted">
                    <p className="text-sm text-ink-secondary">
                        <span className="font-semibold text-ink">Why the beta price?</span> StackRadar is in beta, and
                        the beta price is limited: {BETA_PRICE_SLOTS.pro} Pro and {BETA_PRICE_SLOTS.team} Business
                        subscriptions. After those, or at the stable release, Pro is ${PLAN_DETAILS.pro.standard.month}{' '}
                        and Business ${PLAN_DETAILS.team.standard.month} a month. Subscribe while a slot is open and you
                        keep your beta price for as long as you stay subscribed. Annual billing is ten months&apos;
                        price on either plan.
                    </p>
                </div>
            </div>

            {/* Billing Info - shown for paid plans */}
            {currentPlan !== 'free' && !readOnly && (
                <div className="rounded-md bg-surface-raised border border-edge p-6">
                    <h3 className="text-lg font-medium text-ink mb-2">Billing Information</h3>
                    <p className="text-sm text-ink-muted mb-1">Manage your payment methods and view invoices.</p>
                    {formattedPeriodEnd && !formattedCancelAt && (
                        <p className="text-sm text-ink-muted mb-4">
                            Renews on <span className="font-medium text-ink-secondary">{formattedPeriodEnd}</span>.
                        </p>
                    )}
                    {!formattedPeriodEnd && <div className="mb-4" />}
                    <button
                        className="inline-flex items-center gap-2 px-3 py-2 bg-btn-secondary hover:bg-btn-secondary-hover border border-edge text-ink-secondary text-sm font-medium rounded-md transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
                        onClick={handleManageBilling}
                        disabled={isPortalLoading}
                    >
                        {isPortalLoading ? (
                            <Spinner size="sm" className="text-current" />
                        ) : (
                            <CreditCard className="size-4" />
                        )}
                        Manage Billing
                    </button>
                </div>
            )}
        </div>
    );
}
