'use client'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ChevronRight, ListPlus } from 'lucide-react'
import {
    Badge,
    EntityIcon,
    ExposureDuration,
    KevBadge,
    LoadingBlock,
    PackageIcon,
    RelativeTime,
    SeverityDelta,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    SortableHeader,
    TableHeader,
    TableRow,
} from '@/components/ui'
import { VulnerabilityDialog } from '@/components/clusters'
import { useResource } from '@/hooks'
import { CONTROL_FILTER_PARAM, type ControlFilter } from '@/lib/image-control'
import { withTierParam, type TierLens } from '@/lib/tier-lens'
import { formatShortDigest, isDigestLikeTag } from '@/utils/formatters'
import type { FixListItem } from '@/types/fixes'
import type { MovementContainer, MovementFinding, MovementFindingsResponse, MovementImage, MovementResponse } from '@/types/feed'
import { FixLine, fixFor, type FixIndex } from './fix-hints'

/** The longest window the movement endpoint answers; the page's longer ranges read this much of it. */
const MAX_DAYS = 90
/** Rows shown before the reader asks for the rest. */
const COLLAPSED_ROWS = 3
/** A row this fresh carries the "New" mark — the movement that most likely post-dates the reader's last look. */
const NEW_WITHIN_MS = 24 * 60 * 60 * 1000
/** Packages an unfolded row shows before asking; the server hands back at most a hundred findings. */
const PACKAGES_PREVIEW = 6
/** Advisory ids a package line names before asking. */
const IDS_PREVIEW = 4
/**
 * The bands the block opens on. A week of advisory syncs lands mediums and
 * lows on most images; critical and high are what a reader acts on, and the
 * rest are one toggle away.
 */
const ACTIONABLE = ['critical', 'high'] as const
const BANDS = ['critical', 'high', 'medium', 'low'] as const
type Band = (typeof BANDS)[number]

/** The two orders the table offers: how bad, or how recent. */
type MovementSort = 'findings' | 'when'
const SORT_PHRASE: Record<MovementSort, Record<'asc' | 'desc', string>> = {
    findings: { desc: 'worst first', asc: 'mildest first' },
    when: { desc: 'newest first', asc: 'oldest first' },
}

/** What the block is scoped by: the page's three filters, and its own band toggle. */
export type MovementFilters = {
    /** The page's date range, in days. */
    days: number
    /** Whose images — the page's scope, shared with "Most critical". */
    control: ControlFilter
    /** The page's findings lens: an arrival outside it is not listed. */
    lens: TierLens
    /** Off: critical and high only. On: every band. */
    includeLower: boolean
}

/** The block's query string, in a fixed order so the same view is the same request. */
export function movementQuery({ days, control, lens, includeLower }: MovementFilters): string {
    const params = new URLSearchParams({ days: String(Math.min(days, MAX_DAYS)) })
    if (!includeLower) params.set('severity', ACTIONABLE.join(','))
    if (control !== 'all') params.set(CONTROL_FILTER_PARAM, control)
    return withTierParam(params, lens).toString()
}

/** Where the block's list is read from — the page fetches it, under the scope it shares with the other block. */
export const movementUrl = (filters: MovementFilters) => `/api/feed/movement?${movementQuery(filters)}`
/** Containers an unfolded row lists before asking. */
const CONTAINERS_PREVIEW = 8

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
    enabled: boolean
    /** The response of {@link movementUrl} under `filters`, fetched by the page. */
    data: MovementResponse | null
    error: string | null
    isRefreshing: boolean
    filters: MovementFilters
    onIncludeLowerChange: (next: boolean) => void
    /** Drops the page's image scope — offered when it is what emptied the block. */
    onShowEveryImage: () => void
    fixIndex: FixIndex
}) {
    const { control, includeLower } = filters
    const [expanded, setExpanded] = useState(false)
    const [sort, setSort] = useState<{ column: MovementSort; direction: 'asc' | 'desc' }>({ column: 'findings', direction: 'desc' })
    const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
    const [openVuln, setOpenVuln] = useState<string | null>(null)

    /* Sorted here, over everything the server sent (it caps at 50 images, well
       past what a window holds): "findings" descending is the server's own
       order — KEV, then band and count, recency breaking a tie — so the
       default costs nothing and the other three are a reverse or a date sort.
       Sorted before the fold, so "newest first" changes which three show. */
    const images = useMemo(() => {
        const rows = [...(data?.images ?? [])]
        if (sort.column === 'when') rows.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
        return sort.direction === 'desc' ? rows : rows.reverse()
    }, [data, sort])
    if (!enabled) return null

    const onSort = (column: MovementSort) =>
        setSort(prev => ({ column, direction: prev.column === column && prev.direction === 'desc' ? 'asc' : 'desc' }))
    const shown = expanded ? images : images.slice(0, COLLAPSED_ROWS)
    const hidden = images.length - shown.length
    /* The server's window when it has answered — the plan, or the endpoint's
       own ceiling, may have clamped the page's. */
    const windowDays = data?.days ?? Math.min(filters.days, MAX_DAYS)
    const windowLabel = windowDays === 1 ? 'the last 24 hours' : `the last ${windowDays} days`

    /* Filtered to nothing while other bands have rows: say so, and offer them. */
    const filteredOut = images.length === 0 && !includeLower && (data?.totalImagesAnySeverity ?? 0) > 0
    /* Images the toggle is holding back: those that gained only medium or low findings. */
    const hiddenLower = Math.max(0, (data?.totalImagesAnySeverity ?? 0) - (data?.totalImages ?? 0))
    const whose = control === 'yours' ? 'organization' : control === 'third-party' ? 'third-party' : null

    const toggle = (imageId: string) =>
        setOpen(prev => {
            const next = new Set(prev)
            if (!next.delete(imageId)) next.add(imageId)
            return next
        })

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
                            <span className="text-xs font-normal text-ink-muted">· {windowLabel.replace(/^the /, '')}</span>
                        </span>
                    </h2>
                    <p className="mt-1 text-sm text-ink-muted">
                        Running images that picked up {includeLower ? '' : 'critical or high '}findings in this period, {SORT_PHRASE[sort.column][sort.direction]}.
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
                            onChange={e => onIncludeLowerChange(e.target.checked)}
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
                            No {whose ? `${whose} ` : 'running '}image gained critical or high findings in {windowLabel}.{' '}
                            <button
                                type="button"
                                onClick={() => onIncludeLowerChange(true)}
                                className="cursor-pointer text-accent hover:underline"
                            >
                                Show the {data?.totalImagesAnySeverity?.toLocaleString()} that gained medium or low findings
                            </button>
                        </>
                    ) : whose ? (
                        <>
                            Nothing new hit {whose === 'organization' ? 'an organization image' : 'a third-party image'} in {windowLabel}.{' '}
                            <button type="button" onClick={onShowEveryImage} className="cursor-pointer text-accent hover:underline">
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
                    <TableContainer variant="section" className={isRefreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
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
                                <SortableHeader column="findings" sortColumn={sort.column} sortDirection={sort.direction} onSort={onSort}>
                                    New findings
                                </SortableHeader>
                                <SortableHeader column="when" sortColumn={sort.column} sortDirection={sort.direction} onSort={onSort} hideBelow="lg">
                                    When
                                </SortableHeader>
                                <TableHeader srOnly>Open</TableHeader>
                            </TableHead>
                            <TableBody>
                                {shown.map(image => (
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
                                onClick={() => setExpanded(v => !v)}
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
    )
}

function MovementRow({
    image,
    now,
    expanded,
    filters,
    fixIndex,
    onToggle,
    onOpenVulnerability,
}: {
    image: MovementImage
    now: string
    expanded: boolean
    filters: MovementFilters
    fixIndex: FixIndex
    onToggle: () => void
    onOpenVulnerability: (vulnId: string) => void
}) {
    /* Measured against the server's `until`, not the wall clock: render stays
       pure, and the mark is about the data's age, not how long the tab has been open. */
    const isNew = new Date(now).getTime() - new Date(image.lastAt).getTime() < NEW_WITHIN_MS
    const href = `/images/${image.imageId}`
    /* `:tag` when the image runs under a real one, `@sha256:…` otherwise — the
       reference form a reader would type, not a tag-shaped digest. */
    const tag = image.tag && !isDigestLikeTag(image.tag) ? image.tag : null
    const digest = tag ? null : formatShortDigest(image.digest)
    const label = image.repository ?? 'unknown repository'
    /* The registry host rides in front from `lg` up, where the row has the
       width for the full path. Some repositories already carry their host. */
    const registry =
        image.registry && image.repository && !image.repository.startsWith(`${image.registry}/`)
            ? image.registry
            : null
    const runsIn = image.runsIn ?? []
    const namespaces = [...new Set(runsIn.map(w => w.namespace))]
    /* The server keeps an image for an arrival in a chosen band but counts
       every band; with the toggle off the lower two read as zero here, as the
       findings under the unfolded row already leave them out. */
    const added = filters.includeLower ? image.added : { ...image.added, medium: 0, low: 0 }
    const releaseIds = runsIn.map(c => c.releaseId)
    /* "See fix" is a promise the reader can act on, so only on an image the
       org builds: a third-party image's move is upstream's to ship, and its
       row just opens the image. An older server sends no `control`; the
       move's own says whose it is. */
    const move = fixFor(fixIndex, image.imageId, releaseIds)
    const thirdParty = image.control != null ? image.control === 'third-party' : move?.control === 'third-party'
    const hasMove = move !== undefined && !thirdParty

    return (
        <Fragment>
            {/* The row unfolds; the "Open" link on the right is the way to the
                image page. One click, one thing. */}
            <TableRow onClick={onToggle} selected={expanded} aria-expanded={expanded}>
                <TableCell className="w-8 pr-0">
                    <button
                        type="button"
                        aria-label={`${expanded ? 'Hide' : 'Show'} the findings that arrived on ${label}`}
                        onClick={e => {
                            e.stopPropagation()
                            onToggle()
                        }}
                        className="cursor-pointer rounded-sm p-0.5 hover:bg-btn-secondary-hover"
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={`size-4 text-ink-secondary transition-transform duration-100 ${
                                expanded ? 'rotate-90' : ''
                            }`}
                        />
                    </button>
                </TableCell>
                <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5">
                        <EntityIcon kind="image" />
                        <span className="font-mono text-xs font-medium text-ink break-all">
                            {registry && <span className="hidden text-ink-muted lg:inline">{registry}/</span>}
                            {label}
                            {tag && <span className="text-ink-muted">:{tag}</span>}
                            {digest && <span className="text-ink-muted">@{digest}</span>}
                        </span>
                        {isNew && <Badge variant="accent">New</Badge>}
                    </span>
                    {/* The same digest in two clusters is two rows (images are
                        cluster-scoped), told apart only by the Cluster column —
                        so the name rides under the image while that column is
                        collapsed. */}
                    {image.clusterName && (
                        <span className="mt-0.5 block text-xs text-ink-muted md:hidden">{image.clusterName}</span>
                    )}
                </TableCell>
                <TableCell hideBelow="md" className="text-xs text-ink-secondary whitespace-nowrap">
                    {image.clusterName ? (
                        <span className="inline-flex items-center gap-1.5">
                            <EntityIcon kind="cluster" className="size-3.5 text-ink-muted" />
                            {image.clusterName}
                        </span>
                    ) : (
                        <span className="text-ink-faint">—</span>
                    )}
                </TableCell>
                <TableCell hideBelow="xl" className="text-xs text-ink-secondary whitespace-nowrap">
                    <FirstAndMore values={namespaces} />
                </TableCell>
                <TableCell className="text-xs">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                        <SeverityDelta sign="+" counts={added} noun="added" compact />
                        <KevBadge count={image.kev} />
                    </span>
                </TableCell>
                <TableCell hideBelow="lg" className="text-xs text-ink-muted whitespace-nowrap">
                    <RelativeTime date={new Date(image.lastAt)} />
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap">
                    <Link
                        href={href}
                        onClick={e => e.stopPropagation()}
                        title={
                            hasMove
                                ? 'Open the image — its upgrade recommendation and every finding on it are there'
                                : 'Open the image — every finding on it is listed there'
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                        {/* Says "fix" only once the upgrade list knows a move for one of the org's own images; it lands after the rows do. */}
                        {hasMove ? 'See fix' : 'Open image'}
                        <ArrowRight aria-hidden="true" className="size-3" />
                    </Link>
                </TableCell>
            </TableRow>
            {expanded && (
                <TableRow className="bg-surface-muted">
                    {/* Mounted only while unfolded, so the fetch happens on demand
                        and again on re-open — the list is fresh either way. */}
                    <TableCell colSpan={7} className="pl-4 sm:pl-10">
                        {/* The cell's own padding is the table density's; the
                            cards need more air than a row does. */}
                        <div className="pt-2 pb-5">
                            {/* What arrived first — the question the row's counts
                                raise — then where it runs. */}
                            <MovementFindings
                                image={image}
                                href={href}
                                filters={filters}
                                fixIndex={fixIndex}
                                releaseIds={releaseIds}
                                onOpenVulnerability={onOpenVulnerability}
                            />
                            <MovementContainers
                                clusterId={image.clusterId}
                                containers={runsIn}
                                chartFixes={fixIndex.byRelease}
                            />
                        </div>
                    </TableCell>
                </TableRow>
            )}
        </Fragment>
    )
}

/**
 * The first of a list, and how many more there are. An image usually runs in
 * one place; when it runs in several the row stays one line and the rest are
 * a hover away — the image page lists them all.
 */
function FirstAndMore({ values }: { values: string[] }) {
    if (values.length === 0) return <span className="text-ink-faint">—</span>
    const more = values.length - 1
    return (
        <span title={values.join('\n')}>
            {values[0]}
            {more > 0 && <span className="text-ink-muted"> +{more.toLocaleString()} more</span>}
        </span>
    )
}

/**
 * Every container running the image now, under the unfolded row — the main
 * row says only which cluster and namespace. Already in the block's response, so unfolding fetches nothing for it.
 */
function MovementContainers({
    clusterId,
    containers,
    chartFixes,
}: {
    clusterId: string | null
    containers: MovementContainer[]
    chartFixes: ReadonlyMap<string, FixListItem>
}) {
    const [all, setAll] = useState(false)
    if (containers.length === 0) return null
    const shown = all ? containers : containers.slice(0, CONTAINERS_PREVIEW)
    const hidden = containers.length - shown.length

    return (
        <UnfoldedSection title="Running in" count={containers.length} noun={['container', 'containers']}>
            <TableContainer square>
                <Table aria-label="Containers running this image" density="condensed" textSize="xs">
                    <TableHead>
                        <TableHeader>Container</TableHeader>
                        <TableHeader>Namespace</TableHeader>
                        <TableHeader hideBelow="sm">Kind</TableHeader>
                        {/* What packaged it, when a Helm release claims the
                            workload — the chart is what a fix is cited against. */}
                        <TableHeader hideBelow="md">Helm chart</TableHeader>
                        {/* Per container, so "running this image for": the row is an
                            image with several arrivals, and how long each
                            finding has been there is on its own row above. */}
                        <TableHeader align="end" className="whitespace-nowrap">
                            <span title="How long the container has run this exact image. How long each finding has been in it is on the finding's row.">
                                Running this image for
                            </span>
                        </TableHeader>
                    </TableHead>
                    <TableBody>
                        {shown.map(c => (
                            <TableRow key={c.containerId}>
                                <TableCell className="break-all">
                                    <span className="inline-flex items-center gap-1.5">
                                        <EntityIcon kind="container" className="size-3.5 shrink-0 text-ink-muted" />
                                        <ContainerName clusterId={clusterId} container={c} />
                                    </span>
                                </TableCell>
                                <TableCell className="text-ink-secondary break-all">{c.namespace}</TableCell>
                                <TableCell hideBelow="sm" className="text-ink-muted whitespace-nowrap">
                                    {c.workloadKind ?? <span className="text-ink-faint">—</span>}
                                </TableCell>
                                <TableCell hideBelow="md" className="break-all">
                                    <HelmChart
                                        container={c}
                                        fix={c.releaseId ? chartFixes.get(c.releaseId) : undefined}
                                    />
                                </TableCell>
                                <TableCell align="end" className="text-ink-muted">
                                    <ExposureDuration
                                        since={c.onImageSince}
                                        isLowerBound={c.onImageSinceIsLowerBound}
                                        reason="first-observation"
                                    />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
            {(hidden > 0 || all) && (
                <button
                    type="button"
                    onClick={() => setAll(v => !v)}
                    className="mt-2 cursor-pointer text-xs text-accent hover:underline"
                >
                    {all ? 'Show fewer' : `Show ${hidden.toLocaleString()} more`}
                </button>
            )}
        </UnfoldedSection>
    )
}

/**
 * One of the two lists under an unfolded row. Two header-only tables stacked
 * flush read as one table with a stray header row, so the unfolded area takes
 * the page's muted ground and each list is its own card on it, under a quiet
 * caption saying what it lists and how many.
 */
function UnfoldedSection({
    title,
    count,
    noun,
    children,
}: {
    title: string
    count?: number
    noun: [string, string]
    children: React.ReactNode
}) {
    return (
        <section className="[&+&]:mt-4">
            <h3 className="mb-1.5 text-xs font-medium text-ink">
                {title}
                {count !== undefined && (
                    <span className="font-normal text-ink-muted">
                        {' '}· {count.toLocaleString()} {count === 1 ? noun[0] : noun[1]}
                    </span>
                )}
            </h3>
            {children}
        </section>
    )
}

/**
 * The chart that packaged a container's workload, linked to its release page.
 * A release whose chart metadata could not be read is named by the release;
 * a workload no release claims gets a dash.
 */
function HelmChart({
    container,
    fix,
}: {
    container: MovementContainer
    fix: FixListItem | undefined
}) {
    if (!container.releaseId) return <span className="text-ink-faint">—</span>
    return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
                href={`/releases/${container.releaseId}`}
                onClick={e => e.stopPropagation()}
                title={`Helm release ${container.releaseName ?? ''}`.trim()}
                className="inline-flex items-center gap-1.5 text-ink-secondary underline-offset-2 hover:text-accent hover:underline"
            >
                <EntityIcon kind="chart" className="size-3.5 shrink-0 text-ink-muted" />
                <span>
                    {container.chartName ?? container.releaseName}
                    {container.chartName && container.chartVersion && (
                        <span className="text-ink-muted"> {container.chartVersion}</span>
                    )}
                </span>
            </Link>
            {/* A newer version the upgrade list knows of, stated as exactly
                that: "available". No arrow from the running version — an
                arrow reads as "move here and this is fixed", and nothing on
                this row knows whether the newer chart clears the findings
                above. The release page has the recommendation. */}
            {fix && (
                <Link
                    href={`/releases/${container.releaseId}`}
                    onClick={e => e.stopPropagation()}
                    title="A newer chart version exists — the release page has the recommendation"
                    className="inline-flex items-center gap-1 whitespace-nowrap text-accent hover:underline"
                >
                    {fix.to} available
                    {fix.bump === 'major' && <Badge variant="attention">major</Badge>}
                </Link>
            )}
        </span>
    )
}

/**
 * A container named as the Containers page names it — the workload, plus the
 * container's own name only when it differs — and linked to its page.
 */
function ContainerName({ clusterId, container }: { clusterId: string | null; container: MovementContainer }) {
    const name = (
        <>
            {container.workloadName}
            {container.name !== container.workloadName && <span className="text-ink-muted"> / {container.name}</span>}
        </>
    )
    if (!clusterId) return <span>{name}</span>
    return (
        <Link
            href={`/clusters/${clusterId}/containers/${container.containerId}`}
            onClick={e => e.stopPropagation()}
            className="text-ink-secondary underline-offset-2 hover:text-accent hover:underline"
        >
            {name}
        </Link>
    )
}

/** What arrived on one package version: one upgrade, however many advisories it answers. */
type PackageGroup = {
    key: string
    packageName: string
    packageType: string
    packageVersion: string | null
    /** Every fix version the advisories state, lowest first as strings; usually one. */
    fixedVersions: string[]
    counts: Record<Band, number>
    kev: number
    /** Worst first — the server's order, kept. */
    findings: MovementFinding[]
}

/** The arrivals folded per package version, in the order the worst finding of each first appears. */
function groupByPackage(findings: MovementFinding[]): PackageGroup[] {
    const groups = new Map<string, PackageGroup>()
    for (const f of findings) {
        const key = `${f.packageType}|${f.packageName}|${f.packageVersion ?? ''}`
        let group = groups.get(key)
        if (!group) {
            group = {
                key,
                packageName: f.packageName,
                packageType: f.packageType,
                packageVersion: f.packageVersion,
                fixedVersions: [],
                counts: { critical: 0, high: 0, medium: 0, low: 0 },
                kev: 0,
                findings: [],
            }
            groups.set(key, group)
        }
        group.findings.push(f)
        const band = (f.severityLevel ?? '').toLowerCase()
        if ((BANDS as readonly string[]).includes(band)) group.counts[band as Band]++
        if (f.kevListed) group.kev++
        if (f.fixedVersion && !group.fixedVersions.includes(f.fixedVersion)) group.fixedVersions.push(f.fixedVersion)
    }
    return [...groups.values()]
}

/**
 * What arrived on one image in the block's window, by package, and how to fix
 * it. Worst first: the server orders the findings, and a package takes the
 * place of its worst one.
 */
function MovementFindings({
    image,
    href,
    filters,
    fixIndex,
    releaseIds,
    onOpenVulnerability,
}: {
    image: MovementImage
    href: string
    filters: MovementFilters
    fixIndex: FixIndex
    releaseIds: readonly (string | null)[]
    onOpenVulnerability: (vulnId: string) => void
}) {
    const [all, setAll] = useState(false)
    /* The unfold asks for the bands the block shows; whose image it is was
       decided by the row being here at all. */
    const query = movementQuery({ ...filters, control: 'all' })
    const { data, error } = useResource<MovementFindingsResponse>(
        `/api/feed/movement/${image.imageId}/findings?${query}`,
        { fallbackError: 'Could not load the findings that arrived' }
    )
    const groups = useMemo(() => groupByPackage(data?.findings ?? []), [data])

    const section = (body: React.ReactNode, count?: number) => (
        <UnfoldedSection title="What arrived" count={count} noun={['finding', 'findings']}>
            {body}
        </UnfoldedSection>
    )

    if (!data && !error) return section(<LoadingBlock label="Listing what arrived..." className="py-2" />)
    if (error && !data) return section(<p className="py-1 text-xs text-ink-muted">{error}</p>)
    if (!data) return null

    if (data.findings.length === 0) {
        return section(
            <p className="py-1 text-xs text-ink-muted">
                {data.unmeasuredMoves > 0
                    ? 'The findings came with a new image whose previous digest is no longer known, so they cannot be listed here.'
                    : 'The events for this image do not name the findings that arrived.'}{' '}
                <Link href={href} className="text-accent hover:underline">
                    See every finding on the image page
                </Link>
                .
            </p>
        )
    }

    const shown = all ? groups : groups.slice(0, PACKAGES_PREVIEW)
    const hidden = groups.length - shown.length
    const cut = data.total > data.findings.length
    const packageFixes = groups.flatMap(g => g.fixedVersions.map(v => `${g.packageName} ${v}`))

    return section(
        <>
            <TableContainer square>
                <Table aria-label="Findings that arrived on this image, by package" density="condensed" textSize="xs">
                    <TableHead>
                        <TableHeader>Package</TableHeader>
                        <TableHeader className="whitespace-nowrap">Installed → fixed in</TableHeader>
                        <TableHeader>Arrived</TableHeader>
                        {/* Nested under an indented row, so it has less width
                            than its parent: the ids return at `sm`, the cause
                            at `lg`. */}
                        <TableHeader hideBelow="sm" className="w-full">Vulnerabilities</TableHeader>
                        <TableHeader hideBelow="lg">How it arrived</TableHeader>
                    </TableHead>
                    <TableBody>
                        {shown.map(group => (
                            <PackageGroupRow key={group.key} group={group} onOpenVulnerability={onOpenVulnerability} />
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                {(hidden > 0 || all) && (
                    <button
                        type="button"
                        onClick={() => setAll(v => !v)}
                        className="cursor-pointer text-accent hover:underline"
                    >
                        {all ? 'Show fewer' : `Show ${hidden.toLocaleString()} more ${hidden === 1 ? 'package' : 'packages'}`}
                    </button>
                )}
                {/* Either the server cut the list or the events did not carry
                    every finding; both mean the image page is the whole story. */}
                {(cut || data.partial) && (
                    <span>
                        Not every arrival could be listed here.{' '}
                        <Link href={href} className="text-accent hover:underline">
                            See every finding on the image page
                        </Link>
                        .
                    </span>
                )}
            </div>
            <div className="mt-3">
                <FixLine
                    index={fixIndex}
                    imageId={image.imageId}
                    releaseIds={releaseIds}
                    thirdParty={image.control == null ? null : image.control === 'third-party'}
                    packageFixes={packageFixes}
                    imageHref={href}
                />
            </div>
        </>,
        data.total
    )
}

/** One package version and everything that arrived on it: the upgrade, what it answers, and the ids behind it. */
function PackageGroupRow({ group, onOpenVulnerability }: { group: PackageGroup; onOpenVulnerability: (vulnId: string) => void }) {
    const [all, setAll] = useState(false)
    const ids = all ? group.findings : group.findings.slice(0, IDS_PREVIEW)
    const hidden = group.findings.length - ids.length
    const vias = new Set(group.findings.map(f => f.via))
    /* The longest presence among the scan arrivals: how long the package has
       been running before the advisory database caught up with it. */
    const present = group.findings
        .filter(f => f.via === 'scan' && f.presentSince)
        .sort((a, b) => (a.presentSince! < b.presentSince! ? -1 : 1))[0]

    return (
        <TableRow>
            {/* The ids column takes the slack (`w-full`), so the name holds its line from `sm` up. */}
            <TableCell className="break-all align-top sm:break-normal sm:whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 font-mono text-ink">
                    <PackageIcon purlType={group.packageType} className="size-3.5 shrink-0 text-ink-muted" />
                    {group.packageName}
                </span>
            </TableCell>
            <TableCell className="align-top font-mono whitespace-nowrap">
                <span className="text-ink-secondary">{group.packageVersion ?? '—'}</span>
                <span className="text-ink-muted"> → </span>
                {group.fixedVersions.length > 0 ? (
                    <span className="text-success">{group.fixedVersions.join(', ')}</span>
                ) : (
                    <span className="font-sans text-ink-muted" title="No advisory states a fix version for this package">
                        no fix stated
                    </span>
                )}
            </TableCell>
            <TableCell className="align-top">
                <span className="inline-flex items-center gap-1.5">
                    <SeverityDelta sign="+" counts={group.counts} noun="arrived" compact />
                    <KevBadge count={group.kev} />
                </span>
            </TableCell>
            <TableCell hideBelow="sm" className="align-top">
                <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {ids.map(f => (
                        <FindingId key={f.key} finding={f} onOpen={() => onOpenVulnerability(f.vulnId)} />
                    ))}
                    {(hidden > 0 || all) && group.findings.length > IDS_PREVIEW && (
                        <button
                            type="button"
                            onClick={() => setAll(v => !v)}
                            className="cursor-pointer text-accent hover:underline"
                        >
                            {all ? 'fewer' : `+${hidden.toLocaleString()} more`}
                        </button>
                    )}
                </span>
            </TableCell>
            <TableCell hideBelow="lg" className="align-top text-ink-muted whitespace-nowrap">
                {vias.size > 1 ? 'Advisory updates and a new image' : vias.has('move') ? 'New image' : 'Advisory update'}
                {/* A scan arrival was already there; say for how long. */}
                {present?.presentSince && (
                    <>
                        {' · running for '}
                        <ExposureDuration
                            since={present.presentSince}
                            isLowerBound={present.presentSinceIsLowerBound}
                            reason={present.lowerBoundReason}
                        />
                    </>
                )}
            </TableCell>
        </TableRow>
    )
}

const BAND_DOT: Record<Band, string> = {
    critical: 'bg-sev-critical-emphasis',
    high: 'bg-sev-high-emphasis',
    medium: 'bg-sev-medium-emphasis',
    low: 'bg-sev-low-emphasis',
}

/** One advisory id under a package line: its band as a dot, the id opening the vulnerability dialog. */
function FindingId({ finding, onOpen }: { finding: MovementFinding; onOpen: () => void }) {
    /* The overview resolves the id as written — a GHSA whose identity is its
       CVE lands on the CVE's overview. */
    const href = `/vulnerabilities/${encodeURIComponent(finding.vulnId)}`
    const band = (finding.severityLevel ?? '').toLowerCase()
    const dot = (BANDS as readonly string[]).includes(band) ? BAND_DOT[band as Band] : 'bg-ink-faint'
    return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            {/* A plain click opens the dialog; a modifier click or middle
                click is the browser's, and lands on the page in a new tab. */}
            <Link
                href={href}
                onClick={e => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                    e.preventDefault()
                    onOpen()
                }}
                title={`${finding.vulnId} — ${band || 'unscored'}${finding.kevListed ? ', on CISA KEV' : ''}. What it is and everything running it.`}
                className="font-mono text-ink-secondary hover:text-accent hover:underline"
            >
                {finding.vulnId}
            </Link>
        </span>
    )
}
