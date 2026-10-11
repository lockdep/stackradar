// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import { useOrganization } from '@/components/providers';
import { ApiError, apiFetch, errorMessage } from '@/lib/api-client';

/**
 * Landing-page pricing CTAs arrive as `/?intent=upgrade-<plan>` with an
 * optional `&interval=year` (see landing-page lib/pricing.ts). Not a trial:
 * checkout charges immediately. The price itself is the server's call
 * (beta slot or standard), never a parameter. Rendered by `AppShell` once
 * the organisation is known, on the cloud only.
 */
export function UpgradeIntent() {
    const { organization, isLoading } = useOrganization();
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isLoading || !organization) return;

        const params = new URLSearchParams(window.location.search);
        const intent = params.get('intent');
        const plan = intent === 'upgrade-pro' ? 'pro' : intent === 'upgrade-team' ? 'team' : null;
        const interval = params.get('interval') === 'year' ? 'year' : 'month';
        if (!plan) return;

        // Clear the intent from the URL immediately so it can't re-trigger
        window.history.replaceState({}, '', window.location.pathname);

        // Already paying: checkout would be rejected by the server anyway (plan
        // changes go through the Stripe portal), so send them to billing instead
        // of silently dropping them on the dashboard.
        if (organization.plan !== 'free') {
            router.replace('/org-settings?tab=billing');
            return;
        }

        const successUrl = `${window.location.origin}/org-settings?tab=billing&billing=success`;
        const cancelUrl = `${window.location.origin}/`;

        apiFetch<{ url: string }>('/api/billing/checkout', {
            method: 'POST',
            json: { plan, interval, successUrl, cancelUrl },
        })
            .then(({ url }) => {
                window.location.href = url;
            })
            .catch((err: unknown) => {
                /* The server's refusal is not the reader's to act on here — the wording stays the page's. */
                setError(
                    err instanceof ApiError && err.status > 0
                        ? 'Failed to create checkout session'
                        : errorMessage(err, 'Failed to start checkout'),
                );
            });
    }, [isLoading, organization, router]);

    if (!error) return null;

    return (
        <div
            role="alert"
            className="mb-4 flex items-start gap-3 rounded-md border border-danger-muted bg-danger-subtle p-4"
        >
            <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden="true" />
            <div className="text-sm">
                <p className="font-medium text-danger">Could not start the checkout</p>
                <p className="mt-1 text-danger">{error} You can try again from Organization settings → Billing.</p>
            </div>
        </div>
    );
}
