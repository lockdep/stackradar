// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useEffect, useState } from 'react';
import { signOut } from 'next-auth/react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { Spinner } from '@/components/ui';
import type { Organization } from '@/components/providers';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';
import { PlanCard } from './PlanCard';
import { BillingIntervalToggle } from './BillingIntervalToggle';
import { UpgradeIntent } from './UpgradeIntent';
import { usePlanConfirm } from './usePlanConfirm';
import { PAID_PLANS, TRIAL_DAYS, TRIAL_LINE, type BetaSlots, type BillingInterval, type PaidPlan } from './pricing';

/** Where "Prefer to self-host?" goes: the community edition is the free tier. */
const SELF_HOSTING_URL = 'https://stackradar.io/docs/self-hosting';

/**
 * The only thing a signed-in user of a new organization sees until it has a
 * plan: the two plans, and a checkout that starts the free trial. Rendered
 * by `AppShell` right after the terms gate when the org's `planState` is
 * `never` (`plan-state.ts`) — the server refuses every write on such an org
 * with `plan_required`, so there is nothing else the dashboard could offer.
 *
 * Returning from Stripe lands on `/?billing=success` before the webhook has
 * flipped the plan; the same screen then shows "starting your trial…" and
 * polls (`usePlanConfirm`) until the org row says so, at which point the
 * shell renders the app and its connect-a-cluster flow. Cancelling out of
 * Stripe lands on `/` and the chooser shows again.
 *
 * `UpgradeIntent` is rendered here too: a pricing-page CTA arrives at `/`
 * with `?intent=upgrade-<plan>`, and a new org must go straight to that
 * checkout rather than to a chooser it has already chosen on.
 */
export function PlanGateScreen({ organization }: { organization: Organization }) {
    const [confirming] = useState(() => new URLSearchParams(window.location.search).get('billing') === 'success');
    const { timedOut } = usePlanConfirm(organization.id, confirming);
    const [interval, setInterval_] = useState<BillingInterval>('month');
    const [betaSlots, setBetaSlots] = useState<BetaSlots | null>(null);
    const [trialEligible, setTrialEligible] = useState<boolean>(true);
    const [loadingPlan, setLoadingPlan] = useState<PaidPlan | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        apiFetch<{ betaSlots?: BetaSlots | null; trialEligible?: boolean }>('/api/billing/pricing')
            .then((body) => {
                if (cancelled) return;
                setBetaSlots(body.betaSlots ?? null);
                if (body.trialEligible === false) setTrialEligible(false);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    const startCheckout = async (plan: PaidPlan) => {
        setLoadingPlan(plan);
        setError(null);
        try {
            const { url } = await apiFetch<{ url: string; trial: boolean }>('/api/billing/checkout', {
                method: 'POST',
                json: {
                    plan,
                    interval,
                    successUrl: `${window.location.origin}/?billing=success`,
                    cancelUrl: `${window.location.origin}/`,
                },
            });
            window.location.assign(url);
        } catch (err) {
            setLoadingPlan(null);
            setError(
                err instanceof ApiError && err.status > 0
                    ? 'Could not start the checkout. Try again, or sign in again if it keeps failing.'
                    : errorMessage(err, 'Could not reach the server to start the checkout.'),
            );
        }
    };

    if (confirming && !timedOut) {
        return (
            <div className="min-h-screen bg-surface flex items-center justify-center">
                <div role="status" className="text-center max-w-md px-6">
                    <h1 className="text-2xl font-bold text-ink mb-2">StackRadar</h1>
                    <p className="text-ink-muted mb-6">
                        {trialEligible
                            ? 'Payment method saved, starting your trial…'
                            : 'Payment received, starting your plan…'}
                    </p>
                    <div className="flex justify-center">
                        <Spinner size="lg" className="text-ink-faint" />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-surface flex flex-col">
            <UpgradeIntent />
            <header className="flex items-center justify-between px-6 py-4">
                <span className="text-sm font-semibold text-ink">StackRadar</span>
                <span className="text-sm text-ink-muted truncate max-w-[50%]">{organization.name}</span>
            </header>

            <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:items-center">
                <div className="w-full max-w-4xl">
                    {confirming && timedOut && (
                        <div
                            role="alert"
                            className="mb-6 flex items-start gap-3 rounded-md border border-attention-muted bg-attention-subtle px-4 py-3 text-sm text-attention"
                        >
                            <TriangleAlert className="size-4 shrink-0 mt-0.5" aria-hidden="true" />
                            <span>
                                Payment method saved. Your plan is still being activated — refresh this page in a
                                minute.
                            </span>
                        </div>
                    )}

                    <div className="text-center">
                        <h1 className="text-2xl font-bold text-ink sm:text-3xl">
                            {trialEligible ? `Start your ${TRIAL_DAYS}-day free trial` : 'Choose a plan'}
                        </h1>
                        <p className="mt-2 text-sm text-ink-muted sm:text-base">
                            {trialEligible ? (
                                <>
                                    Every image you run, every cluster, from day one. Add a card now, pay nothing until
                                    the trial ends, cancel before then and you are never charged.
                                </>
                            ) : (
                                <>You have already used your free trial, so billing starts today. Cancel any time.</>
                            )}
                        </p>
                    </div>

                    <div className="mt-6 flex justify-center">
                        <BillingIntervalToggle value={interval} onChange={setInterval_} />
                    </div>

                    {error && (
                        <div
                            role="alert"
                            className="mt-6 flex items-start gap-3 rounded-md border border-danger-muted bg-danger-subtle p-4"
                        >
                            <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden="true" />
                            <p className="text-sm text-danger">{error}</p>
                        </div>
                    )}

                    <div className="mt-8 grid gap-6 md:grid-cols-2">
                        {PAID_PLANS.map((plan) => (
                            <PlanCard
                                key={plan}
                                plan={plan}
                                interval={interval}
                                slots={betaSlots?.[plan] ?? null}
                                isCurrentPlan={false}
                                onSelect={() => void startCheckout(plan)}
                                isUpgrade
                                viaPortal={false}
                                isRecommended={plan === 'pro'}
                                isLoading={loadingPlan === plan}
                                isAnyLoading={loadingPlan !== null}
                                ctaLabel={trialEligible ? 'Start free trial' : 'Subscribe'}
                                ctaNote={
                                    trialEligible ? TRIAL_LINE : 'You have used your free trial; billing starts today.'
                                }
                            />
                        ))}
                    </div>

                    <p className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-ink-muted">
                        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
                        Payments are handled by Stripe. Cancel from the Billing tab at any time.
                    </p>

                    <p className="mt-6 text-center text-sm text-ink-muted">
                        Prefer to self-host? The{' '}
                        <a
                            href={SELF_HOSTING_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-accent hover:underline"
                        >
                            Community Edition
                        </a>{' '}
                        is free.
                        <span className="mx-2 text-ink-faint" aria-hidden="true">
                            ·
                        </span>
                        <button
                            type="button"
                            onClick={() => signOut({ callbackUrl: '/login' })}
                            className="font-medium text-ink-secondary underline underline-offset-2 hover:text-ink cursor-pointer"
                        >
                            Sign out
                        </button>
                    </p>
                </div>
            </main>
        </div>
    );
}
