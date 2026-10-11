'use client';

import { DatabaseZap } from 'lucide-react';
import { usePollWhile, useResource } from '@/hooks';
import { mirrorBannerState, mirrorNeedsPolling, type MirrorStatus } from '@/lib/mirror-status';

/** Bootstraps take minutes; a poll every half minute is plenty to notice the end. */
const POLL_MS = 30_000;

/**
 * The strip above every page while the install's OSV mirror has no live
 * generation yet. A fresh Compose or Helm install answers requests before
 * its bootstrap has finished, so without this the first ten minutes read as
 * "your images have no vulnerabilities". Rendered by `AppShell` in the
 * content column; gone on its own once `initialized` flips, which the poll
 * notices. On the cloud the mirror is always initialised, so this is never
 * drawn there.
 */
export function MirrorBanner() {
    const { data, refetch } = useResource<MirrorStatus>('/api/vulnerabilities/mirror', { cache: 'no-store' });
    usePollWhile(mirrorNeedsPolling(data), refetch, POLL_MS);

    const state = mirrorBannerState(data);
    if (state.kind === 'ready') return null;

    return (
        <div
            role="status"
            aria-label="Vulnerability database"
            className="border-b border-attention-muted bg-attention-subtle px-4 py-2.5 text-sm text-ink-secondary sm:px-6 lg:px-8"
        >
            <p className="flex items-start gap-2 sm:items-center">
                <DatabaseZap aria-hidden className="mt-0.5 size-4 shrink-0 text-attention sm:mt-0" />
                <span>
                    <span className="font-semibold text-ink">Vulnerability database is being built.</span>{' '}
                    {state.kind === 'building'
                        ? 'The first OSV import is running in the background — allow 5–25 minutes depending on your connection. Images show no findings until it finishes; this page updates on its own.'
                        : state.lastError
                          ? `The first OSV import has not completed: ${state.lastError}. The server retries on its schedule; see the server log.`
                          : 'The first OSV import has not started yet. Images show no findings until it finishes; this page updates on its own.'}
                </span>
            </p>
        </div>
    );
}
