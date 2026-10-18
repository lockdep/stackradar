'use client';

import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Circle, DatabaseZap } from 'lucide-react';
import { useNow, usePollWhile, useResource } from '@/hooks';
import { Spinner } from '@/components/ui/Spinner';
import {
    mirrorBannerState,
    mirrorNeedsPolling,
    type FeedLine,
    type FeedStep,
    type MirrorStatus,
} from '@/lib/mirror-status';

/** Progress moves a few times a minute; ten seconds keeps the bar honest without hammering three PK reads. */
const POLL_MS = 10_000;

/**
 * The strip above every page while the install's vulnerability database is
 * still being built: the OSV mirror's first import, then the EPSS and KEV
 * feeds that score it. A fresh Compose or Helm install answers requests
 * before any of that has finished, so without this the first ten minutes
 * read as "your images have no vulnerabilities" — and the ten minutes after
 * as "these scores are final". One row per feed, with the import's position
 * so nobody has to read the server log to know whether it is moving, and
 * the import's ecosystems ticked off one by one as their archives land.
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
            : // Primer's informational flash is the accent blue; the theme's `info`
              // family is Primer's `done` scale, which is purple.
              { strip: 'border-accent-muted bg-accent-subtle', icon: 'text-accent' };

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
                {feed.bar !== null && <ProgressBar name={feed.name} value={feed.bar} />}
                {feed.steps && <StepList feedKey={feed.key} steps={feed.steps} />}
            </span>
        </li>
    );
}

/**
 * The bar under a running feed. A fraction fills it; `indeterminate` runs a
 * segment across it, so the first seconds of a download — before the server
 * has said how big the archive is — look like motion rather than a stall.
 */
function ProgressBar({ name, value }: { name: string; value: number | 'indeterminate' }) {
    const percent = value === 'indeterminate' ? null : Math.round(value * 100);
    return (
        <span
            role="progressbar"
            aria-label={`${name} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="mt-1.5 block h-1.5 w-full max-w-md overflow-hidden rounded-full bg-track"
        >
            {percent === null ? (
                <span className="animate-progress-indeterminate block h-full w-1/3 rounded-full bg-accent-emphasis" />
            ) : (
                <span
                    className="block h-full rounded-full bg-accent-emphasis transition-[width] duration-500"
                    style={{ width: `${percent}%` }}
                />
            )}
        </span>
    );
}

/**
 * The import's archives, one line each, behind a disclosure that is closed
 * by default: the detail line above already says where the import is, and
 * the community default is eighteen ecosystems — too many to stand open on
 * every page. The summary carries the count, so the closed state still
 * answers "how far along".
 */
function StepList({ feedKey, steps }: { feedKey: FeedLine['key']; steps: FeedStep[] }) {
    const [open, setOpen] = useState(false);
    const done = steps.filter((step) => step.status === 'done').length;
    const listId = `mirror-${feedKey}-steps`;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <span className="mt-1.5 block text-xs">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-sm text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
                <Chevron aria-hidden className="size-3.5" />
                {done} of {steps.length} archives imported
            </button>
            {open && (
                <ul id={listId} className="mt-1 space-y-0.5 pl-1">
                    {steps.map((step) => (
                        <StepRow key={step.label} step={step} />
                    ))}
                </ul>
            )}
        </span>
    );
}

/** One ecosystem of the import: a tick once its archive is in, a spinner while it is the one in flight. */
function StepRow({ step }: { step: FeedStep }) {
    const text =
        step.status === 'done' ? 'text-ink-secondary' : step.status === 'running' ? 'text-ink' : 'text-ink-muted';
    return (
        <li className={`flex items-center gap-1.5 ${text}`}>
            <span className="flex size-3 shrink-0 items-center justify-center">
                <StepIcon status={step.status} />
            </span>
            <span className={step.status === 'running' ? 'font-medium' : undefined}>{step.label}</span>
            <span className="text-ink-muted">· {step.detail}</span>
        </li>
    );
}

function StepIcon({ status }: { status: FeedStep['status'] }) {
    switch (status) {
        case 'done':
            return <CheckCircle2 aria-label="Done" className="size-3 text-success" />;
        case 'running':
            return <Spinner size="xs" className="text-accent" />;
        case 'pending':
            return <Circle aria-label="Waiting" className="size-2.5 text-ink-faint" />;
    }
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
