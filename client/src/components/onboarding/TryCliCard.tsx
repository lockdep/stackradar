'use client';

import { ArrowUpRight, Terminal } from 'lucide-react';
import { CLI_PAGE_URL } from '@/lib/cli';
import { CliInstallBlock } from './CliInstallBlock';

/**
 * The lower-commitment path beside every "connect a cluster" ask: scan from
 * the laptop, nothing installed, nothing sent. Rendered under the primary
 * card on the onboarding gate and under the empty states on the Dashboard
 * and Clusters pages — the three places a user without a cluster lands.
 *
 * Quieter than the card it follows on purpose: flat surface, no shadow, a
 * left-aligned reading order rather than the centred pitch above it. It is an
 * alternative, not a second call to action competing for the same click.
 */
export function TryCliCard({ className = '' }: { className?: string }) {
    return (
        <section
            aria-labelledby="try-cli-heading"
            className={`rounded-md border border-edge bg-surface px-5 py-5 text-left ${className}`}
        >
            <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0 rounded-md bg-surface-muted p-2 ring-1 ring-edge">
                    <Terminal className="size-4 text-ink-secondary" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 id="try-cli-heading" className="text-sm font-semibold text-ink">
                        Want to see a result before installing anything?
                    </h2>
                    <p className="mt-1 text-sm text-ink-muted">
                        <code className="font-mono text-[13px] text-ink-secondary">stackradar scan</code> checks every
                        image running in your current kube context, from your terminal. Nothing is installed in the
                        cluster and nothing is sent to StackRadar.
                    </p>
                </div>
            </div>
            <div className="mt-4">
                <CliInstallBlock />
            </div>
            <p className="mt-2 text-xs text-ink-muted">
                <a
                    href={CLI_PAGE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
                >
                    Other install methods, and what the CLI does
                    <ArrowUpRight className="size-3" aria-hidden="true" />
                </a>
            </p>
        </section>
    );
}
