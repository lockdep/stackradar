'use client'

import { Fragment, useCallback, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Gauge, RefreshCw, TriangleAlert } from 'lucide-react'
import {
    Button,
    KevBadge,
    LoadingBlock,
    PaginationFooter,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TotalRiskChip,
    UnderlineRadioGroup,
} from '@/components/ui'
import { RadarScoreFindingsRow, type FindingsEntry } from './RadarScoreFindingsRow'
import { useControlFilter, usePagedResource, useTierLens } from '@/hooks'
import { CONTROL_FILTERS, CONTROL_FILTER_HINT, CONTROL_FILTER_LABEL } from '@/lib/image-control'
import { withTierParam, type TierCounts, type TierLens } from '@/lib/tier-lens'
import { PAGE_SIZE } from '@/lib/constants'
import { TOTAL_RISK_HINT } from '@/lib/risk'
import { formatShortDigest } from '@/utils/formatters'
import { shortDigest } from '@/utils/containerUtils'
import type { ClusterRadarScoreFinding, ClusterRadarScoreImage, ClusterRadarScoreResponse } from '@/types/cluster'

/** How many containers a row names before folding the rest into "+N more". */
const CONTAINERS_SHOWN = 2

/**
 * The image's pullable name: `registry/repository:tag`, as a `kubectl` user
 * would write it. The tag comes from the deployments (a digest has none of
 * its own), so several tags are listed and none leaves just the path; an
 * image with no name at all falls back to its short digest.
 */
function imageLabel(image: ClusterRadarScoreImage): string {
    const path = [image.registry, image.repository].filter(Boolean).join('/')
    if (!path) return shortDigest(image.digest)
    return image.tags.length > 0 ? `${path}:${image.tags.join(', ')}` : path
}

type Props = {
    /**
     * The BFF list endpoint; `/findings` hangs off it.
     * `/api/clusters/:id/radar-score` on a cluster tab, `/api/radar-score`
     * for the organization — same parameters, same response.
     */
    apiBase: string
    /** Keys expansion, findings and paging state: the cluster id, or the org id. */
    contextKey: string
    /**
     * Set on a cluster tab. Absent, the list is org-wide: rows gain a
     * Cluster column and workload links go into each row's own cluster.
     */
    clusterId?: string
    /** Whose Radar Score the caption says this is ("prod-eu" / "This organization"). */
    scopeName: string
    /** `h1` where the list is the page, `h2` inside a tab. */
    headingLevel: 'h1' | 'h2'
    ariaLabel: string
    emptyText: string
    /**
     * Where the headline number is charted, for the caption's honesty
     * clause: the breakdown is live, the chart is the hourly snapshot.
     */
    chartOwner: 'Overview' | 'Dashboard'
    className?: string
}

/**
 * The Radar Score, taken apart.
 *
 * The Overview's (or Dashboard's) chart shows one number; this lists what it
 * is made of. The row unit is the **image**, because images are the only
 * unit that partitions the total — a finding belongs to one image and an
 * image to one cluster, so the scores down this column add up to the number
 * on the chart. Workloads would double-count a shared base image, so they
 * appear as context on the row rather than as rows. Expanding an image lists
 * the findings that add up to its share, largest contribution first.
 *
 * The cluster Radar Score tab and the org-wide `/radar-score` page, which
 * differ only in the endpoint they page over and in whether a row needs to
 * say which cluster it is in.
 */
export function RadarScoreBreakdown({
    apiBase,
    contextKey,
    clusterId,
    scopeName,
    headingLevel,
    ariaLabel,
    emptyText,
    chartOwner,
    className = '',
}: Props) {
    /* Expansion and findings are keyed by `contextKey|imageId` rather than
       reset on navigation — the component instance survives a cluster switch
       (same route, new param), and the other context's entries are simply
       never looked up. */
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [entries, setEntries] = useState<Record<string, FindingsEntry>>({})
    /* The lens narrows the expanded findings only. The image rows and their
       scores are the Radar Score itself, which never reads the lens. */
    const { lens, setLens } = useTierLens()
    const { control, setControl } = useControlFilter()

    const loadFindings = useCallback(
        (imageId: string, forLens: TierLens = lens) => {
            const key = `${contextKey}|${imageId}|${forLens}`
            setEntries(prev => ({ ...prev, [key]: { status: 'loading' } }))
            const params = withTierParam(new URLSearchParams({ imageId }), forLens)
            fetch(`${apiBase}/findings?${params}`)
                .then(r => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`)
                    return r.json() as Promise<{ findings: ClusterRadarScoreFinding[]; tierCounts?: TierCounts }>
                })
                .then(({ findings, tierCounts }) =>
                    setEntries(prev => ({ ...prev, [key]: { status: 'loaded', findings, tierCounts } }))
                )
                .catch(() => setEntries(prev => ({ ...prev, [key]: { status: 'error' } })))
        },
        [apiBase, contextKey, lens]
    )

    /* A lens change leaves open rows open; fetch what they now need. Done in
       the handler rather than an effect — the change is an event. */
    const changeLens = (next: TierLens) => {
        setLens(next)
        for (const openKey of expanded) {
            const [ctx, imageId] = openKey.split('|')
            if (ctx === contextKey && imageId && !entries[`${openKey}|${next}`]) loadFindings(imageId, next)
        }
    }

    const toggleExpanded = (imageId: string) => {
        const key = `${contextKey}|${imageId}`
        setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
        if (!entries[`${key}|${lens}`]) loadFindings(imageId)
    }

    const { setOffset, data, error, isStale, isRefreshing, isLoaded, handleRefresh } =
        usePagedResource<ClusterRadarScoreResponse>({
            contextKey,
            scope: control,
            makeUrl: ({ limit, offset }) => {
                const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
                if (control !== 'all') params.set('control', control)
                return `${apiBase}?${params}`
            },
            errorFallback: 'Failed to load the Radar Score breakdown',
        })

    if (!isLoaded) {
        return <LoadingBlock label="Loading Radar Score breakdown..." />
    }

    if (error && !data) {
        return (
            <div className="flex flex-col items-center gap-3 py-24">
                <p className="text-sm font-medium text-ink">Failed to load the Radar Score breakdown</p>
                <p className="text-sm text-ink-muted">{error}</p>
                <Button variant="secondary" onClick={handleRefresh} loading={isRefreshing}>
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    Try again
                </Button>
            </div>
        )
    }

    const images = data?.images ?? []
    const total = data?.total ?? 0
    const imageCount = data?.imageCount ?? 0
    const findingCount = data?.findingCount ?? 0
    const shownOffset = data?.offset ?? 0
    /* Colour for the headline comes from the worst image on the first page —
       the list is sorted by share, not by worst finding, so this is "at least
       this bad", which is the honest direction to err in. */
    const worstBand = images[0]?.band
    const showClusters = !clusterId
    const columnCount = showClusters ? 7 : 6
    const Heading = headingLevel

    return (
        <div className={className}>
            <div className="mb-3 flex items-end justify-between gap-4">
                <div className="min-w-0">
                    <Heading
                        className={`flex items-center gap-2 font-semibold text-ink ${
                            headingLevel === 'h1' ? 'text-xl' : 'text-base'
                        }`}
                    >
                        <Gauge aria-hidden="true" className="size-4 text-ink-muted" />
                        Radar Score
                        <TotalRiskChip score={total} band={worstBand} title={TOTAL_RISK_HINT} />
                        {isStale && <Spinner size="sm" className="text-ink-faint" />}
                    </Heading>
                    <p className="mt-1 text-sm text-ink-muted">
                        {scopeName}&apos;s Radar Score is the sum of {findingCount.toLocaleString()}{' '}
                        {findingCount === 1 ? 'finding' : 'findings'} across {imageCount.toLocaleString()}{' '}
                        scanned {imageCount === 1 ? 'image' : 'images'}
                        {showClusters ? ' in every cluster' : ''}. Each row is one image&apos;s share,
                        largest first; expand it to see the findings that add up to it. The number here
                        is live, so it can run ahead of the {chartOwner}&apos;s hourly chart; the colour
                        is the worst image on this page.
                    </p>
                    {data?.byControl && total > 0 && (
                        /* The same sum, split by who can act on it — not a
                           second score. Each half filters the list below. */
                        <p className="mt-1 text-sm text-ink-secondary">
                            <button
                                type="button"
                                onClick={() => setControl('yours')}
                                className="cursor-pointer hover:text-accent hover:underline"
                            >
                                Within your control:{' '}
                                <span className="font-semibold tabular-nums text-ink">
                                    {Math.round(data.byControl.yours).toLocaleString()}
                                </span>
                            </button>
                            {' · '}
                            <button
                                type="button"
                                onClick={() => setControl('third-party')}
                                className="cursor-pointer hover:text-accent hover:underline"
                            >
                                Waiting on upstream:{' '}
                                <span className="font-semibold tabular-nums text-ink">
                                    {Math.round(data.byControl.upstream).toLocaleString()}
                                </span>
                            </button>
                            {data.byControl.unconfirmedImages > 0 && (
                                <span className="text-ink-muted">
                                    {' '}(includes {data.byControl.unconfirmedImages.toLocaleString()} unconfirmed{' '}
                                    {data.byControl.unconfirmedImages === 1 ? 'image' : 'images'} —{' '}
                                    <Link href="/org-settings?tab=image-ownership" className="text-accent hover:underline">
                                        confirm them
                                    </Link>
                                    )
                                </span>
                            )}
                        </p>
                    )}
                </div>
                <Button
                    variant="secondary"
                    onClick={handleRefresh}
                    loading={isRefreshing}
                    title="Refresh Radar Score breakdown"
                    className="shrink-0 pl-2 pr-2"
                >
                    {!isRefreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
                    <span className="sr-only">Refresh</span>
                </Button>
            </div>

            {error && (
                <p className="mb-3 flex items-start gap-2 rounded-md border border-attention-muted bg-attention-subtle px-3 py-2 text-sm text-attention">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>Could not refresh — showing the last loaded list. {error}</span>
                </p>
            )}

            {/* No counts on the segments: the list is paged, and the split line
                above already says how the score divides. */}
            <UnderlineRadioGroup
                options={CONTROL_FILTERS}
                value={control}
                onChange={setControl}
                label={CONTROL_FILTER_LABEL}
                hint={CONTROL_FILTER_HINT}
                ariaLabel="Whose images to list"
                className="mb-3"
            />

            <div className={isStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                <TableContainer variant="section">
                    <Table aria-label={ariaLabel} density="condensed">
                        <TableHead>
                            <TableHeader srOnly className="w-7 pl-3 pr-0">
                                Expand
                            </TableHeader>
                            {/* A phone keeps the image and its share — the
                                two columns that add up. Findings return at
                                `md`, the containers at `lg`; the worst finding
                                and the cluster wait for `xl`, since the
                                expanded row lists the findings anyway and the
                                image link opens its cluster. */}
                            <TableHeader>Image</TableHeader>
                            {showClusters && <TableHeader hideBelow="xl">Cluster</TableHeader>}
                            <TableHeader hideBelow="lg">Containers</TableHeader>
                            <TableHeader hideBelow="md" align="end">Findings</TableHeader>
                            <TableHeader hideBelow="xl">Worst finding</TableHeader>
                            <TableHeader align="end">Radar Score</TableHeader>
                        </TableHead>
                        {images.length === 0 ? (
                            <TableEmpty colSpan={columnCount}>{emptyText}</TableEmpty>
                        ) : (
                            <TableBody>
                                {images.map(image => {
                                    const key = `${contextKey}|${image.imageId}`
                                    const isExpanded = expanded.has(key)
                                    const label = imageLabel(image)
                                    const shownContainers = image.workloads.slice(0, CONTAINERS_SHOWN)
                                    const hiddenContainers = image.workloads.length - shownContainers.length
                                    return (
                                        <Fragment key={image.imageId}>
                                            <TableRow onClick={() => toggleExpanded(image.imageId)}>
                                                <TableCell className="w-7 pl-3 pr-0 text-ink-faint">
                                                    <button
                                                        type="button"
                                                        aria-expanded={isExpanded}
                                                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} findings for ${label}`}
                                                        onClick={e => {
                                                            e.stopPropagation()
                                                            toggleExpanded(image.imageId)
                                                        }}
                                                        className="cursor-pointer rounded-sm p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                                    >
                                                        {isExpanded ? (
                                                            <ChevronDown aria-hidden="true" className="size-3.5" />
                                                        ) : (
                                                            <ChevronRight aria-hidden="true" className="size-3.5" />
                                                        )}
                                                    </button>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex min-w-0 flex-col">
                                                        <Link
                                                            href={`/images/${image.imageId}`}
                                                            onClick={e => e.stopPropagation()}
                                                            className="font-mono text-xs font-medium text-ink hover:text-accent hover:underline break-all"
                                                        >
                                                            {label}
                                                        </Link>
                                                        <span
                                                            className="font-mono text-[11px] text-ink-muted"
                                                            title={image.digest}
                                                        >
                                                            digest {formatShortDigest(image.digest)}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                {showClusters && (
                                                    <TableCell hideBelow="xl" className="text-xs">
                                                        <Link
                                                            href={`/clusters/${image.clusterId}/radar-score`}
                                                            onClick={e => e.stopPropagation()}
                                                            className="text-ink-secondary hover:text-accent hover:underline"
                                                            title="This cluster’s own Radar Score breakdown"
                                                        >
                                                            {image.clusterName}
                                                        </Link>
                                                    </TableCell>
                                                )}
                                                <TableCell hideBelow="lg" className="text-xs">
                                                    {image.workloads.length === 0 ? (
                                                        /* Scanned but not in any inventory yet — a dash
                                                           says "not running" less loudly than a zero. */
                                                        <span className="text-ink-muted">—</span>
                                                    ) : (
                                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                                            {shownContainers.map(w => (
                                                                <Link
                                                                    key={w.containerId}
                                                                    href={`/clusters/${image.clusterId}/containers/${w.containerId}`}
                                                                    onClick={e => e.stopPropagation()}
                                                                    title={w.workloadKind ?? 'Unknown kind'}
                                                                    className="font-mono text-ink-secondary hover:text-accent hover:underline"
                                                                >
                                                                    {w.namespaceName}/{w.workloadName}
                                                                </Link>
                                                            ))}
                                                            {hiddenContainers > 0 && (
                                                                <span
                                                                    className="text-ink-muted"
                                                                    title={image.workloads
                                                                        .slice(CONTAINERS_SHOWN)
                                                                        .map(w => `${w.namespaceName}/${w.workloadName}`)
                                                                        .join('\n')}
                                                                >
                                                                    +{hiddenContainers} more
                                                                </span>
                                                            )}
                                                        </span>
                                                    )}
                                                </TableCell>
                                                <TableCell hideBelow="md" align="end" className="tabular-nums text-ink-secondary">
                                                    <span title="One finding is one advisory on one package in this image">
                                                        {image.findingCount.toLocaleString()}
                                                    </span>
                                                </TableCell>
                                                <TableCell hideBelow="xl" className="text-xs">
                                                    {image.topFinding ? (
                                                        <span className="inline-flex flex-wrap items-center gap-1.5">
                                                            <span className="font-mono text-ink-secondary">
                                                                {image.topFinding.vulnId}
                                                            </span>
                                                            <span className="tabular-nums text-ink-muted">
                                                                {Math.round(image.topFinding.risk)}/100
                                                            </span>
                                                            <KevBadge count={image.kevCount} />
                                                        </span>
                                                    ) : (
                                                        <span className="text-ink-muted">—</span>
                                                    )}
                                                </TableCell>
                                                <TableCell align="end">
                                                    <TotalRiskChip
                                                        score={image.score}
                                                        band={image.band}
                                                        title={[
                                                            `${Math.round(image.score).toLocaleString()} of ${Math.round(total).toLocaleString()} — summed over ${image.findingCount} finding${image.findingCount === 1 ? '' : 's'}`,
                                                            TOTAL_RISK_HINT,
                                                        ].join('\n')}
                                                    />
                                                </TableCell>
                                            </TableRow>
                                            {isExpanded && (
                                                <RadarScoreFindingsRow
                                                    imageLabel={label}
                                                    score={image.score}
                                                    entry={entries[`${key}|${lens}`]}
                                                    lens={lens}
                                                    onLensChange={changeLens}
                                                    onRetry={() => loadFindings(image.imageId)}
                                                    colSpan={columnCount}
                                                />
                                            )}
                                        </Fragment>
                                    )
                                })}
                            </TableBody>
                        )}
                    </Table>
                </TableContainer>
            </div>

            <PaginationFooter
                total={imageCount}
                pageSize={PAGE_SIZE}
                shownOffset={shownOffset}
                shownCount={images.length}
                isStale={isStale}
                unit="images"
                onOffsetChange={setOffset}
            />
        </div>
    )
}
