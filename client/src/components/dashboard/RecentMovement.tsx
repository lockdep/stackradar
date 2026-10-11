'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ListPlus } from 'lucide-react';
import {
    LoadingBlock,
    Table,
    TableBody,
    TableContainer,
    TableHead,
    SortableHeader,
    TableHeader,
} from '@/components/ui';
import { VulnerabilityDialog } from '@/components/clusters';
import type { MovementResponse } from '@/types/feed';
import type { FixIndex } from './fix-hints';
import { MAX_DAYS, type MovementFilters } from './movement-query';
import { MovementRow } from './MovementRow';

export { movementUrl, type MovementFilters } from './movement-query';

/** Rows shown before the reader asks for the rest. */
const COLLAPSED_ROWS = 3;

/** The two orders the table offers: how bad, or how recent. */
type MovementSort = 'findings' | 'when';
const SORT_PHRASE: Record<MovementSort, Record<'asc' | 'desc', string>> = {
    findings: { desc: 'worst first', asc: 'mildest first' },
    when: { desc: 'newest first', asc: 'oldest first' },
};

/**
 * "New vulnerabilities on running images" — the Dashboard's answer to the one question a
 * returning reader has: did anything my pods are running pick up findings
 * lately? One row per image that gained findings in the page's date range, worst
 * first (the server's order: KEV, then band and count, recency breaking a
 * tie), each unfolding to what arrived and how to fix it.
 *
 * The data is the Feed's: `scan.findings-changed` events (the advisory
 * database changed under an image already running) and measured
 * `container.image-changed` moves (a new tag brought findings the old one
 * did not), folded per image by the server (`GET /api/feed/movement`).
 * Inventory churn — containers appearing, leaving, rolling — is not here;
 * it is not risk, and the Feed has it.
 *
 * The page's date range rather than "since your last visit": a window
 * keyed on the reader's own behaviour showed a daily visitor nothing and a
 * returning one a wall, and changed on every refresh. Within the range, a row
 * younger than a day is marked "New".
 *
 * Three rows by default, because this sits above "Most critical" and must
 * not push it off the screen; the rest unfold in place. The empty state
 * still renders — "nothing new hit a running image" is the reassurance the
 * block exists to give.
 *
 * A row unfolds in place to list the findings that arrived — the question the
 * counts raise — and then the containers running the image. The image page lists every finding on the image with no
 * "arrived this week" filter, so this is the only surface that answers it.
 * The list is fetched on unfold (`GET /api/feed/movement/:imageId/findings`),
 * so the block's own response stays a few rows of counts.
 *
 * A finding row opens the vulnerability in a dialog rather than on its page:
 * every block here refetches on return, so reading up on an advisory and
 * coming back would reload the Dashboard. The id stays a real link for a
 * modifier-click or a new tab.
 *
 * One checkbox, not four chips: the block opens on critical and high, and
 * "Include medium and low" is the only other view a reader asked for. The
 * server filters (`severity=`), so its cap applies to what matches. Whose
 * images (`control=`) is the page's scope, shared with "Most critical". Both
 * are the page's state, as is the fetch.
 *
 * The unfolded row groups what arrived by package — seven advisories on one
 * openssl are one upgrade, and read as seven problems when listed flat — and
 * ends with the fix: the measured move when the upgrade list has one, the
 * package versions to rebuild with when it does not.
 *
 * A chart in the containers table that the org's upgrade list has a move for
 * says so — "1.12.1 available", never an arrow that would promise a fix —
 * and links to the release page, where the recommendation is. No comparison
 * here: this table says where the image runs. The list is the page's
 * (`fixes`), so the mark appears when that slower fetch lands; until then
 * the chart is just named. No mark never claims "up to date" — only that no
 * move is known.
 *
 * The window, whose images and the findings lens are the Dashboard filter
 * bar's, carried by every request here (`days=`, `control=`, `tier=`) like
 * every other block's. The window was a fixed week and the lens absent; a
 * page-wide filter that one block ignored was the thing the bar replaced.
 */
export function RecentMovement({
    enabled,
    data,
    error,
    isRefreshing,
    filters,
    onIncludeLowerChange,
    onShowEveryImage,
    fixIndex,
}: {
    enabled: boolean;
    /** The response of {@link movementUrl} under `filters`, fetched by the page. */
    data: MovementResponse | null;
    error: string | null;
    isRefreshing: boolean;
    filters: MovementFilters;
    onIncludeLowerChange: (next: boolean) => void;
    /** Drops the page's image scope — offered when it is what emptied the block. */
    onShowEveryImage: () => void;
    fixIndex: FixIndex;
}) {
    const { control, includeLower } = filters;
    const [expanded, setExpanded] = useState(false);
    const [sort, setSort] = useState<{ column: MovementSort; direction: 'asc' | 'desc' }>({
        column: 'findings',
        direction: 'desc',
    });
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
    const [openVuln, setOpenVuln] = useState<string | null>(null);

    /* Sorted here, over everything the server sent (it caps at 50 images, well
       past what a window holds): "findings" descending is the server's own
       order — KEV, then band and count, recency breaking a tie — so the
       default costs nothing and the other three are a reverse or a date sort.
       Sorted before the fold, so "newest first" changes which three show. */
    const images = useMemo(() => {
        const rows = [...(data?.images ?? [])];
        if (sort.column === 'when') rows.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
        return sort.direction === 'desc' ? rows : rows.reverse();
    }, [data, sort]);
    if (!enabled) return null;

    const onSort = (column: MovementSort) =>
        setSort((prev) => ({
            column,
            direction: prev.column === column && prev.direction === 'desc' ? 'asc' : 'desc',
        }));
    const shown = expanded ? images : images.slice(0, COLLAPSED_ROWS);
    const hidden = images.length - shown.length;
    /* The server's window when it has answered — the plan, or the endpoint's
       own ceiling, may have clamped the page's. */
    const windowDays = data?.days ?? Math.min(filters.days, MAX_DAYS);
    const windowLabel = windowDays === 1 ? 'the last 24 hours' : `the last ${windowDays} days`;

    /* Filtered to nothing while other bands have rows: say so, and offer them. */
    const filteredOut = images.length === 0 && !includeLower && (data?.totalImagesAnySeverity ?? 0) > 0;
    /* Images the toggle is holding back: those that gained only medium or low findings. */
    const hiddenLower = Math.max(0, (data?.totalImagesAnySeverity ?? 0) - (data?.totalImages ?? 0));
    const whose = control === 'yours' ? 'organization' : control === 'third-party' ? 'third-party' : null;

    const toggle = (imageId: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (!next.delete(imageId)) next.add(imageId);
            return next;
        });

    return (
        <section aria-labelledby="recent-movement-heading" className="mt-8">
            <div className="mb-3 flex items-end justify-between gap-4">
                <div className="min-w-0">
                    <h2
                        id="recent-movement-heading"
                        className="flex items-center gap-1.5 text-base font-semibold text-ink"
                    >
                        <ListPlus aria-hidden="true" className="size-4 text-ink-muted" />
                        {/* The smaller caption is centred on the title rather than
                            sharing its baseline, where it read as sitting low. */}
                        <span className="flex flex-wrap items-center gap-x-1.5">
                            New vulnerabilities on running images
                            {/* The window is part of the name: "new" is a claim about
                                the page's date range, not about today, and a title
                                that said only "new" contradicted a 30-day range
                                beside it. Rows younger than a day still carry their
                                own "New" mark. */}
                            <span className="text-xs font-normal text-ink-muted">
                                · {windowLabel.replace(/^the /, '')}
                            </span>
                        </span>
                    </h2>
                    <p className="mt-1 text-sm text-ink-muted">
                        Running images that picked up {includeLower ? '' : 'critical or high '}findings in this period,{' '}
                        {SORT_PHRASE[sort.column][sort.direction]}.
                    </p>
                </div>
                <Link
                    href="/feed"
                    className="inline-flex shrink-0 items-center gap-1 text-sm text-accent hover:underline"
                >
                    Open the Feed
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
            </div>

            {/* As in MostCritical: the hook fetches as a refresh when the gate flips,
                so "no data yet" is loading whatever `isLoading` says. */}
            {/* A checkbox, as "Include unscored" is on the findings tables: a
                lone chip reads as a tag, and the option is one yes/no. It says
                how many rows it is holding back while it is off. */}
            {data && (
                <div className="mb-3">
                    <label
                        className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary select-none whitespace-nowrap"
                        title="Also list images that gained only medium or low findings"
                    >
                        <input
                            type="checkbox"
                            checked={includeLower}
                            onChange={(e) => onIncludeLowerChange(e.target.checked)}
                            className="accent-accent-emphasis"
                        />
                        Include medium and low
                        {!includeLower && hiddenLower > 0 && (
                            <span className="tabular-nums text-ink-muted">
                                ({hiddenLower.toLocaleString()} more {hiddenLower === 1 ? 'image' : 'images'})
                            </span>
                        )}
                    </label>
                </div>
            )}

            {!data && !error ? (
                <LoadingBlock label="Checking what arrived on running images..." className="py-8" />
            ) : error && !data ? (
                <p className="text-sm text-ink-muted">{error}</p>
            ) : !data || images.length === 0 ? (
                <p className="rounded-md border border-edge bg-surface-raised px-4 py-3 text-sm text-ink-muted">
                    {filteredOut ? (
                        <>
                            No {whose ? `${whose} ` : 'running '}image gained critical or high findings in {windowLabel}
                            .{' '}
                            <button
                                type="button"
                                onClick={() => onIncludeLowerChange(true)}
                                className="cursor-pointer text-accent hover:underline"
                            >
                                Show the {data?.totalImagesAnySeverity?.toLocaleString()} that gained medium or low
                                findings
                            </button>
                        </>
                    ) : whose ? (
                        <>
                            Nothing new hit {whose === 'organization' ? 'an organization image' : 'a third-party image'}{' '}
                            in {windowLabel}.{' '}
                            <button
                                type="button"
                                onClick={onShowEveryImage}
                                className="cursor-pointer text-accent hover:underline"
                            >
                                Show every image
                            </button>
                        </>
                    ) : (
                        <>Nothing new hit a running image in {windowLabel}.</>
                    )}
                </p>
            ) : (
                <>
                    {/* A scope or toggle change keeps the last rows up while the new ones load; dimmed, so they are not read as the new view's. */}
                    <TableContainer
                        variant="section"
                        className={isRefreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}
                    >
                        <Table aria-label={`Images that gained findings in ${windowLabel}`} density="condensed">
                            <TableHead>
                                <TableHeader srOnly className="w-8">
                                    Findings
                                </TableHeader>
                                <TableHeader className="w-full">Image</TableHeader>
                                {/* A phone keeps the image, the arrivals and
                                    the way in. Where it runs comes back a
                                    column at a time: the cluster at `md`, the
                                    timestamp at `lg`, the namespace at `xl` —
                                    the "New" badge on the image already says
                                    which rows are fresh. The containers are
                                    a table under the unfolded row. */}
                                <TableHeader hideBelow="md">Cluster</TableHeader>
                                <TableHeader hideBelow="xl">Namespace</TableHeader>
                                <SortableHeader
                                    column="findings"
                                    sortColumn={sort.column}
                                    sortDirection={sort.direction}
                                    onSort={onSort}
                                >
                                    New findings
                                </SortableHeader>
                                <SortableHeader
                                    column="when"
                                    sortColumn={sort.column}
                                    sortDirection={sort.direction}
                                    onSort={onSort}
                                    hideBelow="lg"
                                >
                                    When
                                </SortableHeader>
                                <TableHeader srOnly>Open</TableHeader>
                            </TableHead>
                            <TableBody>
                                {shown.map((image) => (
                                    <MovementRow
                                        key={image.imageId}
                                        image={image}
                                        now={data.until}
                                        expanded={open.has(image.imageId)}
                                        filters={filters}
                                        fixIndex={fixIndex}
                                        onOpenVulnerability={setOpenVuln}
                                        onToggle={() => toggle(image.imageId)}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                    {/* The toggle only exists when there is something to unfold. */}
                    {(hidden > 0 || expanded) && data && data.totalImages > COLLAPSED_ROWS && (
                        <div className="mt-2 text-xs text-ink-muted">
                            <button
                                type="button"
                                onClick={() => setExpanded((v) => !v)}
                                aria-expanded={expanded}
                                className="cursor-pointer text-accent hover:underline"
                            >
                                {expanded
                                    ? 'Show fewer'
                                    : `Show all ${images.length.toLocaleString()} ${images.length === 1 ? 'image' : 'images'}`}
                                {/* The server hands back at most fifty; say so when it cut. */}
                                {!expanded && data.totalImages > images.length && (
                                    <span className="text-ink-muted"> of {data.totalImages.toLocaleString()}</span>
                                )}
                            </button>
                        </div>
                    )}
                </>
            )}
            <VulnerabilityDialog vulnId={openVuln} onClose={() => setOpenVuln(null)} />
        </section>
    );
}
