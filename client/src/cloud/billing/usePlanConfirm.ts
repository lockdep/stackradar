// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useEffect, useState } from 'react';
import { useOrganization } from '@/components/providers';
import { apiFetch } from '@/lib/api-client';

/**
 * How long to keep asking the server whether the checkout webhook has landed.
 * Stripe usually delivers within a couple of seconds; 30s covers a slow retry
 * without leaving a spinner up forever.
 */
const PLAN_CONFIRM_INTERVAL_MS = 2000;
const PLAN_CONFIRM_MAX_ATTEMPTS = 15;

/**
 * Stripe redirects back before its webhook has told us about the new
 * subscription, so right after `?billing=success` the org can still read
 * "no plan" for a few seconds. While `active`, poll the org until its plan
 * flips and push the row into the organization context — which is what
 * dismisses the plan chooser or the "confirming" banner — rather than claim
 * a plan the page does not yet show. Gives up quietly after the window;
 * `timedOut` is the caller's cue to say "refresh in a minute".
 */
export function usePlanConfirm(orgId: string, active: boolean): { timedOut: boolean } {
    const { updateOrganization } = useOrganization();
    const [timedOut, setTimedOut] = useState(false);

    useEffect(() => {
        if (!active) return;
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
                setTimedOut(true);
            }
        }, PLAN_CONFIRM_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [active, orgId, updateOrganization]);

    return { timedOut };
}
