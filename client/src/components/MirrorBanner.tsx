'use client';

import { AlertCircle, CheckCircle2, Circle, DatabaseZap } from 'lucide-react';
import { useNow, usePollWhile, useResource } from '@/hooks';
import { Spinner } from '@/components/ui/Spinner';
import { mirrorBannerState, mirrorNeedsPolling, type FeedLine, type MirrorStatus } from '@/lib/mirror-status';

/** Progress moves a few times a minute; ten seconds keeps the bar honest without hammering three PK reads. */
const POLL_MS = 10_000;

/**
 * The strip above every page while the install's vulnerability database is
 * still being built: the OSV mirror's first import, then the EPSS and KEV
 * feeds that score it. A fresh Compose or Helm install answers requests
 * before any of that has finished, so without this the first ten minutes
 * read as "your images have no vulnerabilities" — and the ten minutes after
 * as "these scores are final". One row per feed, with the import's position
 * so nobody has to read the server log to know whether it is moving.
 * Rendered by `AppShell` in the content column; gone on its own once every
 * feed has landed, which the poll notices. On the cloud the three are
 * always in place, so this is never drawn there.
 */
export function MirrorBanner() {
    const { data, refetch } = useResource<MirrorStatus>('/api/vulnerabilities/mirror', { cache: 'no-store' });
    const polling = mirrorNeedsPolling(data);
    usePollWhile(polling, refetch, POLL_MS);
    // The elapsed times tick between polls; off once there is nothing to time.
    const now = useNow(polling ? 1_000 : 60_000);

    const state = mirrorBannerState(data, now);
    if (state.kind === 'ready') return null;

    const tone =
        state.tone === 'danger'
            ? { strip: 'border-danger-muted bg-danger-subtle', icon: 'text-danger' }
            : { strip: 'border-attention-muted bg-attention-subtle', icon: 'text-attention' };

    return (
        <div
            role="status"
            aria-label="Vulnerability database"
            className={`border-b px-4 py-3 text-sm text-ink-secondary sm:px-6 lg:px-8 ${tone.strip}`}
        >
            <p className="flex items-start gap-2">
                <DatabaseZap aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone.icon}`} />
                <span>
                    <span className="font-semibold text-ink">{state.headline}</span> {state.summary}
                </span>
            </p>
            <ul className="mt-2.5 space-y-1.5 pl-6">
                {state.feeds.map((feed) => (
                    <FeedRow key={feed.key} feed={feed} />
                ))}
            </ul>
        </div>
    );
}

function FeedRow({ feed }: { feed: FeedLine }) {
    return (
        <li className="flex items-start gap-2">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <StatusIcon status={feed.status} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-ink">{feed.name}</span>
                    <span className="text-xs text-ink-muted">{feed.role}</span>
                </span>
                <span className="block break-words">{feed.detail}</span>
                {feed.fraction !== null && (
                    <span
                        role="progressbar"
                        aria-label={`${feed.name} progress`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(feed.fraction * 100)}
                        className="mt-1.5 block h-1.5 w-full max-w-md overflow-hidden rounded-full bg-track"
                    >
                        <span
                            className="block h-full rounded-full bg-accent-emphasis transition-[width] duration-500"
                            style={{ width: `${Math.round(feed.fraction * 100)}%` }}
                        />
                    </span>
                )}
            </span>
        </li>
    );
}

function StatusIcon({ status }: { status: FeedLine['status'] }) {
    switch (status) {
        case 'ready':
            return <CheckCircle2 aria-label="Done" className="size-4 text-success" />;
        case 'running':
            return <Spinner size="sm" className="text-accent" />;
        case 'failed':
            return <AlertCircle aria-label="Failed" className="size-4 text-danger" />;
        case 'pending':
            return <Circle aria-label="Waiting" className="size-3 text-ink-faint" />;
    }
}
