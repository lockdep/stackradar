// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client'

import { Terminal } from 'lucide-react'
import { CLI_PAGE_URL } from '@/lib/cli'

/** Where "Start free" goes: the real app, not this deployment. */
export const APP_LOGIN_URL = 'https://app.stackradar.io/login'

/**
 * The live demo's standing disclosure (docs/live-demo/ step 02), rendered by
 * `AppShell` above the content of every page and never dismissable: the
 * reader must be able to tell, on any page they land on from a shared link,
 * that this is a simulation they cannot change. The two links are the two
 * exits — the CLI for a result on their own cluster without an account, and
 * the app for the account.
 */
export function DemoBanner() {
    return (
        <div
            role="note"
            aria-label="Live demo"
            className="border-b border-accent-muted bg-accent-subtle px-4 py-2.5 text-sm text-ink-secondary sm:px-6 lg:px-8"
        >
            {/* Phones stack the two rows; from `sm` up they share one line
                and the text takes the slack. Kept to one short sentence: it is
                a standing header on every page. */}
            <div className="flex flex-col gap-y-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
                <p className="sm:min-w-0 sm:flex-1">
                    <span className="font-semibold text-ink">Live demo</span> — an example cluster. You can
                    look, but not change anything.
                </p>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:shrink-0">
                    <a
                        href={CLI_PAGE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
                    >
                        <Terminal aria-hidden className="size-3.5" />
                        Scan your own cluster
                    </a>
                    <a
                        href={APP_LOGIN_URL}
                        className="inline-flex items-center rounded-md bg-accent-emphasis px-2.5 py-1 text-xs font-semibold text-on-emphasis hover:bg-accent-emphasis-hover"
                    >
                        Start free
                    </a>
                </p>
            </div>
        </div>
    )
}
