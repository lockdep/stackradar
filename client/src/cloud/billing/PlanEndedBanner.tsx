// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { PLAN_LIMITS } from '@/components/organization-settings/constants';

/**
 * The standing notice on every page of an organization whose plan ended
 * (`planState === 'lapsed'`): the dashboard is readable, nothing can be
 * changed, the scanner's uploads are refused, and history is on the
 * no-plan window (`PLAN_LIMITS.free.historyDays`). Same slot as the live
 * demo's banner, never dismissable, because the reader must be able to tell
 * on any page why a button did nothing. The one link is the way back.
 */
export function PlanEndedBanner() {
    return (
        <div
            role="note"
            aria-label="Plan ended"
            className="border-b border-attention-muted bg-attention-subtle px-4 py-2.5 text-sm text-ink-secondary sm:px-6 lg:px-8"
        >
            <div className="flex flex-col gap-y-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
                <p className="flex items-start gap-2 sm:min-w-0 sm:flex-1">
                    <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-attention" />
                    <span>
                        <span className="font-semibold text-ink">Your plan has ended.</span> The dashboard is read-only
                        and the scanner&apos;s uploads are paused. History older than {PLAN_LIMITS.free.historyDays}{' '}
                        days is removed.
                    </span>
                </p>
                <p className="sm:shrink-0">
                    <Link
                        href="/org-settings?tab=billing"
                        className="inline-flex items-center rounded-md bg-accent-emphasis px-2.5 py-1 text-xs font-semibold text-on-emphasis hover:bg-accent-emphasis-hover"
                    >
                        Start a plan
                    </Link>
                </p>
            </div>
        </div>
    );
}
