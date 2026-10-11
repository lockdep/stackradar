'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
    ArrowRightLeft,
    ChevronDown,
    ChevronRight,
    CircleDot,
    GitBranch,
    PackageMinus,
    PackagePlus,
    RefreshCw,
} from 'lucide-react';
import { Button, DaysFilter, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui';
import { ScopeSelect } from '@/components/containers';
import { useResource } from '@/hooks';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import { getPlanHistoryDays } from '@/components/organization-settings/constants';
import type { Cluster } from '@/types/cluster';

type ClusterName = Pick<Cluster, 'id' | 'name'>;
import { useFeed } from '@/components/feed/useFeed';
import { dayHeading, groupByDay, type DayGroup, type DaySummary } from '@/components/feed/dayGroups';
import { FeedEntry } from '@/components/feed/FeedEntry';
import { CLUSTER_COL, SeverityDeltaPair, TIME_COL } from '@/components/feed/columns';

/**
 * The Feed — what changed in the org's fleet, one block per calendar day,
 * newest first.
 *
 * Every line is a *change*: a finding that arrived or left, an image that
 * appeared or went away, a container that moved from one digest to another.
 * Never inventory. The day blocks and the folding of repeats are read-time
 * choices made here, in the viewer's timezone; the server hands back a flat
 * page.
 */

function plural(n: number, one: string, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * One figure in a day's summary: an icon, a signed count, and the sentence on
 * hover. The tooltip is hover-only, so the sentence is also the accessible
 * name — the icon and sign are the only visible cues to what is counted.
 */
function SummaryChip({
    icon: Icon,
    sign,
    count,
    tone,
    label,
}: {
    icon: typeof CircleDot;
    sign?: '+' | '−';
    count: number;
    tone?: 'danger' | 'success';
    label: string;
}) {
    if (count <= 0) return null;
    const toneClass = tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-ink-muted';
    return (
        <span className="group/chip relative">
            <span
                role="img"
                aria-label={label}
                className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums ${toneClass}`}
            >
                <Icon aria-hidden className="size-3.5" />
                {sign}
                {count}
            </span>
            <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-2 py-1 text-xs font-medium text-surface opacity-0 transition-opacity group-hover/chip:opacity-100"
            >
                {label}
                <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-ink" />
            </span>
        </span>
    );
}

function SummaryLine({ summary: s }: { summary: DaySummary }) {
    const any = Object.values(s).some((n) => n > 0);
    if (!any) return null;
    /* Chips first, squares last: the squares share a column with the rows'
       counters below. `ml-auto` is for the phone, where the day header wraps
       and the summary drops to its own line — it stays on the right edge. */
    return (
        <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <SummaryChip
                icon={PackagePlus}
                sign="+"
                count={s.containersTracked}
                label={`${plural(s.containersTracked, 'container')} now tracked`}
            />
            <SummaryChip
                icon={PackageMinus}
                sign="−"
                count={s.containersUntracked}
                label={`${plural(s.containersUntracked, 'container')} no longer tracked`}
            />
            <SummaryChip
                icon={ArrowRightLeft}
                count={s.containersMoved}
                label={`${plural(s.containersMoved, 'container')} changed image`}
            />
            <SummaryChip
                icon={GitBranch}
                count={s.rolloutsInProgress}
                label={`${plural(s.rolloutsInProgress, 'rollout')} still in progress`}
            />
            <span className="flex items-center gap-1.5">
                <SeverityDeltaPair
                    removed={s.findingsResolvedBySeverity}
                    added={s.findingsAddedBySeverity}
                    removedNoun="lost"
                    addedNoun="gained"
                />
            </span>
        </span>
    );
}

/** The calendar date behind a relative heading, so "Today" still says which day. */
function dayDate(date: Date): string {
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * One day on the rail: the dot, the heading with its summary, and the
 * entries beneath it. The day folds like an entry does — a chevron leads the
 * heading, and a closed day keeps its summary line so the reader still sees
 * what the day held. Today opens by default; every other day starts closed.
 * The dot is anchored to the heading's own line box, not the row, so a
 * taller summary chip or a wrapped summary never pulls the text away from it.
 */
function FeedDay({ group, showCluster }: { group: DayGroup; showCluster: boolean }) {
    const heading = dayHeading(group.date);
    const isToday = heading === 'Today';
    /* Only today starts open: the page answers "what changed" first, and the
       summary line on each closed day is enough to decide whether to dig. */
    const [open, setOpen] = useState(isToday);
    const relative = isToday || heading === 'Yesterday';
    const Chevron = open ? ChevronDown : ChevronRight;
    const headingId = `feed-day-${group.key}`;
    const listId = `feed-day-list-${group.key}`;
    const changes = group.lines.reduce((n, line) => n + line.repeats.length, 0);

    return (
        <li aria-labelledby={headingId} className="relative pl-6 pb-7 last:pb-0">
            {/* Same gap and right padding as an entry row, and the same trailing columns reserved
                empty, so the summary's squares end on the rows' counter edge. Wraps on a phone:
                the heading keeps its line and the summary takes the next one. */}
            <div className="flex flex-wrap items-center gap-2 pr-2">
                {/* `basis-full` below `sm`: the heading owns its line and the summary
                    takes the next; from `sm` the two share one. */}
                <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-x-3 gap-y-0.5 sm:basis-0">
                    {/* Dot, chevron and heading never wrap apart: the dot is centred on this group. */}
                    <span className="relative flex h-5 items-center gap-2">
                        {/* The dot on the rail. Today's is accent; the past is a plain mark. */}
                        <span
                            aria-hidden
                            className={`absolute top-1/2 -left-[29px] size-[9px] -translate-y-1/2 rounded-full ring-4 ring-surface ${
                                isToday ? 'bg-accent-emphasis' : 'bg-edge-strong'
                            }`}
                        />
                        <button
                            type="button"
                            onClick={() => setOpen((v) => !v)}
                            aria-expanded={open}
                            aria-controls={listId}
                            aria-label={open ? `Collapse ${heading}` : `Expand ${heading}`}
                            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-ink-faint hover:text-ink"
                        >
                            <Chevron aria-hidden className="size-3.5" />
                        </button>
                        <h2
                            id={headingId}
                            onClick={() => setOpen((v) => !v)}
                            className="cursor-pointer text-sm font-semibold leading-5 text-ink select-none"
                        >
                            {heading}
                        </h2>
                    </span>
                    {relative && <span className="text-xs text-ink-faint">{dayDate(group.date)}</span>}
                    {!open && <span className="text-xs text-ink-faint">{plural(changes, 'change')}</span>}
                </div>
                <SummaryLine summary={group.summary} />
                {showCluster && <span aria-hidden className={CLUSTER_COL} />}
                <span aria-hidden className={TIME_COL} />
            </div>
            {open && (
                <ul id={listId} className="mt-1.5 ml-4">
                    {group.lines.map((line) => (
                        <FeedEntry key={line.event.id} line={line} showCluster={showCluster} />
                    ))}
                </ul>
            )}
        </li>
    );
}

export function FeedView() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { organization } = useOrganization();

    /* The cluster scope lives in the URL: a scoped feed is a linkable place. */
    const clusterId = searchParams.get('cluster');
    const setCluster = (id: string | null) => {
        const params = new URLSearchParams(searchParams.toString());
        if (id) params.set('cluster', id);
        else params.delete('cluster');
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname);
    };

    const [days, setDays] = useState(30);
    const { edition } = useRuntimeConfig();
    const maxDays = getPlanHistoryDays(organization?.plan, edition);

    /* The names-only list, not `/api/clusters`: that one folds risk and
       coverage for the whole org, which a scope picker has no use for and
       which can take long enough that the picker seems to be missing. */
    const { data: clusters } = useResource<ClusterName[]>('/api/clusters/names', {
        select: (body) => {
            const list = (body as { clusters?: unknown }).clusters;
            return Array.isArray(list) ? (list as ClusterName[]) : [];
        },
    });
    const { events, error, isLoading, isLoadingMore, hasMore, served, refresh, loadMore } = useFeed(
        Math.min(days, maxDays),
        clusterId,
    );

    const groups = events ? groupByDay(events) : [];
    const showCluster = !clusterId && (clusters?.length ?? 0) > 1;

    return (
        <div>
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-ink">Feed</h1>
                    <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                        What changed in the containers you track, day by day: image changes and what they did to the
                        findings, advisories that landed on a running image, containers that came and went.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {/* Shown even with one cluster: "All clusters" is what tells the reader the scope. */}
                    {clusters && clusters.length > 0 && (
                        <ScopeSelect
                            label="Scope to cluster"
                            value={clusterId}
                            onChange={setCluster}
                            allLabel="All clusters"
                            options={clusters.map((c) => ({ value: c.id, label: c.name }))}
                        />
                    )}
                    <DaysFilter value={Math.min(days, maxDays)} onChange={setDays} maxDays={maxDays} />
                    <Button variant="secondary" onClick={() => void refresh()}>
                        <RefreshCw aria-hidden className="size-4" /> Refresh
                    </Button>
                </div>
            </header>

            <div className="mt-6">
                {isLoading && !events && <LoadingBlock label="Loading the feed…" />}

                {error && !events && (
                    <ErrorBlock title="Failed to load the feed" message={error} onRetry={() => void refresh()} />
                )}

                {events && events.length === 0 && (
                    <p className="py-10 text-center text-sm text-ink-muted">
                        Nothing has changed in the last {served?.days ?? days} days. Image changes, new advisories
                        against running images and containers that come and go land here — one entry per change, never
                        one per finding.
                    </p>
                )}

                {groups.length > 0 && (
                    <ol className="relative ml-1.5 border-l border-edge">
                        {groups.map((group) => (
                            <FeedDay key={group.key} group={group} showCluster={showCluster} />
                        ))}
                    </ol>
                )}

                {hasMore && (
                    <div className="mt-6 flex justify-center">
                        <Button variant="secondary" onClick={() => void loadMore()} disabled={isLoadingMore}>
                            {isLoadingMore ? <Spinner size="sm" /> : null} Load older
                        </Button>
                    </div>
                )}

                {events && events.length > 0 && !hasMore && served && served.days < days && (
                    <p className="mt-6 text-center text-xs text-ink-muted">
                        Your plan keeps {served.historyDays} days of history.
                    </p>
                )}
            </div>
        </div>
    );
}
