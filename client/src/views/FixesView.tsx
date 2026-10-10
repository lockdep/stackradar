'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { ArrowRight, CircleFadingArrowUp, RefreshCw } from 'lucide-react'
import {
    Badge,
    EntityIcon,
    Button,
    ErrorBlock,
    KevBadge,
    LoadingBlock,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TotalRiskChip,
} from '@/components/ui'
import { useOrganization } from '@/components/providers/OrganizationProvider'
import { useResource } from '@/hooks'
import { TOTAL_RISK_HINT } from '@/lib/risk'
import { FIX_SECTION_HINT, FIX_SECTION_LABEL, clearedSplit, fixEntityKind, fixKindLabel, groupFixes, splitRemainder } from '@/lib/fix-groups'
import type { FixListItem, FixesResponse, NoRecommendationItem, NoRecommendationReason } from '@/types/fixes'

/**
 * `/fixes` — every upgrade the product can recommend across every cluster,
 * ranked by the Radar Score contribution it clears, and under it every image
 * with findings that has no recommended move, with the reason.
 *
 * The recommendations themselves already existed, but only four clicks deep:
 * `ImageUpgradePanel` on `/images/[id]` and `ChartUpgradePanel` on
 * `/releases/[id]`. This page is the index over them — one row per move,
 * each opening the detail page that carries the full panel and the delivery
 * command. It is deliberately a read-only list: no issues, no suppressions,
 * no "apply". The rules `UpgradeRecommendation.tsx` states hold here too —
 * never imply safety, never hide a refusal, never conflate "no newer
 * version" with "not measured".
 */
export function FixesView() {
    const { organization } = useOrganization()
    const orgId = organization?.id ?? null

    const { data, error, isRefreshing, refetch } = useResource<FixesResponse>(
        orgId ? '/api/remediation/fixes' : null,
        { refreshKey: orgId ? 1 : 0, fallbackError: 'Failed to load fixes', revalidateOnFocus: true }
    )

    /* "No data yet" is loading, whatever the hook's flag says: the provider
       renders this view before the org has loaded, so the hook mounts with
       the url null and its first real fetch runs as a refresh — keyed on
       `isLoading`, the empty state flashed until the response landed. */
    if (!organization || (!data && !error)) {
        return <LoadingBlock label="Working out which upgrades clear the most..." />
    }

    if (error && !data) {
        return <ErrorBlock title="Failed to load fixes" message={error} onRetry={() => void refetch()} />
    }

    const fixes = data?.fixes ?? []
    const { yours: remainder, waitingOnUpstream } = splitRemainder(data?.noRecommendation ?? [])
    const totals = data?.totals ?? { upgrades: 0, findingsCleared: 0, kevCleared: 0 }

    return (
        <div>
            <div className="mb-6 flex items-start justify-between gap-4 border-b border-edge pb-4">
                <div className="min-w-0">
                    <h1 className="flex items-center gap-2 text-xl font-bold text-ink sm:text-2xl">
                        <CircleFadingArrowUp aria-hidden="true" className="size-5 text-ink-muted" />
                        Fixes
                    </h1>
                    <p className="mt-1 text-sm text-ink-muted">
                        <TotalsLine totals={totals} />
                    </p>
                </div>
                <Button
                    variant="secondary"
                    onClick={() => void refetch()}
                    loading={isRefreshing}
                    title="Refresh fixes"
                    className="shrink-0 pl-2 pr-2"
                >
                    {!isRefreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
                    <span className="sr-only">Refresh</span>
                </Button>
            </div>

            <p className="mb-3 text-sm text-ink-muted">
                One row per move. What is in your control comes first — application moves before
                base-image ones — then the upgrades that are upstream&apos;s to ship, each ranked by the
                Radar Score contribution it clears, exploited findings first. Measured rows compare two SBOMs we hold; an unmeasured row only
                says a newer chart exists. Open a row for the full comparison and the delivery
                command. A version bump can break things: this says what it clears and what it
                leaves, nothing about whether it is safe to deploy.
            </p>

            <TableContainer variant="section">
                <Table aria-label="Recommended upgrades across all clusters" density="condensed">
                    <TableHead>
                        <TableHeader>Move</TableHeader>
                        <TableHeader hideBelow="lg">Cluster</TableHeader>
                        <TableHeader hideBelow="md">Clears</TableHeader>
                        <TableHeader align="end">Risk cleared</TableHeader>
                        <TableHeader hideBelow="lg" align="end">Containers</TableHeader>
                        <TableHeader hideBelow="xl">Delivery</TableHeader>
                    </TableHead>
                    {fixes.length === 0 ? (
                        <TableEmpty colSpan={6}>
                            No upgrade to recommend yet. A move needs two scanned versions of the
                            same image or chart to compare — the section below says where that
                            evidence is missing.
                        </TableEmpty>
                    ) : (
                        <TableBody>
                            {groupFixes(fixes).map(group => (
                                <Fragment key={group.key}>
                                    {/* A section row, not a second table: the columns are
                                        the same and the ranking inside each is the server's. */}
                                    <tr>
                                        <th
                                            colSpan={6}
                                            scope="colgroup"
                                            title={FIX_SECTION_HINT[group.key]}
                                            className="border-t border-edge bg-surface-muted/60 px-3 py-1.5 text-left text-xs font-semibold text-ink-secondary"
                                        >
                                            {FIX_SECTION_LABEL[group.key]}
                                            <span className="ml-1.5 font-normal tabular-nums text-ink-muted">
                                                {group.fixes.length.toLocaleString()}
                                            </span>
                                        </th>
                                    </tr>
                                    {group.fixes.map(fix => (
                                        <FixRow key={fix.id} fix={fix} />
                                    ))}
                                </Fragment>
                            ))}
                        </TableBody>
                    )}
                </Table>
            </TableContainer>

            {/* Never hide a refusal: an image with findings and no move is a
                real answer, and rendering it as silence reads as "nothing to
                fix". */}
            <h2 className="mb-1 mt-8 flex items-center gap-2 text-base font-semibold text-ink">
                No recommendation yet
                <Badge variant="neutral">{remainder.length.toLocaleString()}</Badge>
            </h2>
            <p className="mb-3 text-sm text-ink-muted">
                Images you control with findings that no move on this page covers, and why. Each reason is the
                scan&apos;s own verdict, not a guess.
            </p>
            <TableContainer variant="section">
                <Table aria-label="Images with findings and no recommended upgrade" density="condensed">
                    <TableHead>
                        <TableHeader>Image</TableHeader>
                        <TableHeader hideBelow="lg">Cluster</TableHeader>
                        <TableHeader hideBelow="sm" align="end">Findings</TableHeader>
                        <TableHeader align="end">Radar Score</TableHeader>
                        <TableHeader hideBelow="md">Why</TableHeader>
                    </TableHead>
                    {remainder.length === 0 ? (
                        <TableEmpty colSpan={5}>
                            Every image with findings has a move on the list above.
                        </TableEmpty>
                    ) : (
                        <TableBody>
                            {remainder.map(item => (
                                <NoRecommendationRow key={item.imageId} item={item} />
                            ))}
                        </TableBody>
                    )}
                </Table>
            </TableContainer>

            {/* The third group, folded: third-party images with findings and
                nothing to upgrade to. There is nothing to do about them but
                wait, and a count that opens says so without burying the two
                lists above it. */}
            {waitingOnUpstream.length > 0 && (
                <details className="mt-8">
                    <summary className="cursor-pointer text-base font-semibold text-ink">
                        Waiting on upstream
                        <span className="ml-2 align-middle">
                            <Badge variant="neutral">{waitingOnUpstream.length.toLocaleString()}</Badge>
                        </span>
                        <span className="ml-2 text-sm font-normal text-ink-muted">
                            third-party {waitingOnUpstream.length === 1 ? 'image' : 'images'} with findings and no
                            newer version to move to
                        </span>
                    </summary>
                    <TableContainer variant="section" className="mt-3">
                        <Table aria-label="Third-party images waiting on an upstream fix" density="condensed">
                            <TableHead>
                                <TableHeader>Image</TableHeader>
                                <TableHeader hideBelow="lg">Cluster</TableHeader>
                                <TableHeader hideBelow="sm" align="end">Findings</TableHeader>
                                <TableHeader align="end">Radar Score</TableHeader>
                                <TableHeader hideBelow="md">Why</TableHeader>
                            </TableHead>
                            <TableBody>
                                {waitingOnUpstream.map(item => (
                                    <NoRecommendationRow key={item.imageId} item={item} />
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </details>
            )}
        </div>
    )
}

/** "3 upgrades would clear 41 findings (2 on KEV)." — measured moves only. */
function TotalsLine({ totals }: { totals: FixesResponse['totals'] }) {
    if (totals.upgrades === 0) {
        return <>No measured upgrade to recommend across this organization yet.</>
    }
    return (
        <>
            <strong className="text-ink">{totals.upgrades.toLocaleString()}</strong>{' '}
            {totals.upgrades === 1 ? 'upgrade' : 'upgrades'} would clear{' '}
            <strong className="text-ink">{totals.findingsCleared.toLocaleString()}</strong>{' '}
            {totals.findingsCleared === 1 ? 'finding' : 'findings'}
            {totals.kevCleared > 0 && (
                <>
                    {' '}
                    ({totals.kevCleared.toLocaleString()} on KEV)
                </>
            )}
            .
        </>
    )
}

function targetHref(fix: FixListItem): string {
    return fix.target.type === 'image'
        ? `/images/${fix.target.imageId}`
        : `/releases/${fix.target.releaseId}`
}

function FixRow({ fix }: { fix: FixListItem }) {
    const href = targetHref(fix)
    return (
        <TableRow hoverable>
            <TableCell>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <Link
                        href={href}
                        className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs font-medium text-ink hover:text-accent hover:underline"
                    >
                        <span className="break-all">{fix.subject}</span>
                        <span className="text-ink-muted">{fix.from ?? 'digest'}</span>
                        <ArrowRight aria-hidden="true" className="size-3 text-ink-muted" />
                        <span>{fix.to}</span>
                    </Link>
                    <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                        <Badge variant={fix.kind === 'chart' ? 'accent' : 'neutral'} className="gap-1">
                            <EntityIcon kind={fixEntityKind(fix)} className="size-3" />
                            {fixKindLabel(fix)}
                        </Badge>
                        <Badge variant={fix.bump === 'major' ? 'attention' : 'neutral'}>
                            {fix.bump} bump
                        </Badge>
                        {fix.evidence === 'chart-index' && (
                            <span
                                className="shrink-0"
                                title="Measured by the public chart index on the chart's default values — not on this release's values. An image tag you override is not part of it."
                            >
                                <Badge variant="muted">measured on default values</Badge>
                            </span>
                        )}
                        {!fix.measured && (
                            <Badge variant="muted">unmeasured — newer chart exists</Badge>
                        )}
                        {fix.release && (
                            <span className="font-mono">
                                {fix.release.namespace}/{fix.release.name}
                            </span>
                        )}
                        {/* The Cluster column is collapsed below `lg`. */}
                        {fix.cluster.name && <span className="lg:hidden">{fix.cluster.name}</span>}
                    </span>
                </div>
            </TableCell>
            <TableCell hideBelow="lg" className="text-xs text-ink-secondary">{fix.cluster.name ?? '—'}</TableCell>
            <TableCell hideBelow="md" className="text-xs">
                {fix.cleared ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5 text-ink">
                        <span>
                            {fix.cleared.findings.toLocaleString()}{' '}
                            {fix.cleared.findings === 1 ? 'finding' : 'findings'}
                        </span>
                        {fix.cleared.high > 0 && (
                            <span className="text-ink-muted">· {fix.cleared.high} high or critical</span>
                        )}
                        <KevBadge count={fix.cleared.kev} />
                        {fix.cleared.introduced > 0 && (
                            <span className="text-attention">· introduces {fix.cleared.introduced}</span>
                        )}
                        {clearedSplit(fix) && <span className="basis-full text-ink-muted">{clearedSplit(fix)}</span>}
                    </span>
                ) : fix.upperBound ? (
                    /* "could address up to", never "will" — nothing has scanned the target. */
                    <span className="text-ink-muted">
                        could address up to {fix.upperBound.findings.toLocaleString()} fixable{' '}
                        {fix.upperBound.findings === 1 ? 'finding' : 'findings'}
                    </span>
                ) : (
                    <span className="text-ink-muted">—</span>
                )}
            </TableCell>
            <TableCell align="end">
                {fix.riskRemoved != null ? (
                    <TotalRiskChip
                        score={fix.riskRemoved}
                        title={`Radar Score contribution this move removes.\n${TOTAL_RISK_HINT}`}
                    />
                ) : fix.upperBound ? (
                    <span
                        className="text-xs tabular-nums text-ink-muted"
                        title="Upper bound — Σ contribution of the release's currently fixable findings. Unmeasured: nothing has scanned the newer chart."
                    >
                        ≤ {Math.round(fix.upperBound.risk).toLocaleString()}
                    </span>
                ) : (
                    <span className="text-ink-muted">—</span>
                )}
            </TableCell>
            <TableCell hideBelow="lg" align="end" className="tabular-nums text-ink-secondary">
                <span
                    title={
                        fix.kind === 'chart'
                            ? `${fix.containers} containers across ${fix.images} ${fix.images === 1 ? 'image' : 'images'} the bump moves`
                            : `${fix.containers} containers run this image`
                    }
                >
                    {fix.containers.toLocaleString()}
                </span>
            </TableCell>
            <TableCell hideBelow="xl" className="text-xs text-ink-secondary">
                {fix.delivery ? (
                    <span className="font-mono">{fix.delivery}</span>
                ) : (
                    <span className="text-ink-muted">—</span>
                )}
            </TableCell>
        </TableRow>
    )
}

/** Why there is no move, in the user's terms rather than the scanner's. */
const REASON_COPY: Record<NoRecommendationReason, string> = {
    'no-candidates':
        'No other scanned tag of this repository in your organization to compare against.',
    'up-to-date':
        'Already the newest tag of this repository anyone here has scanned — not the same as the newest tag that exists.',
    'not-measured':
        'A newer version is known, but nothing has scanned what it deploys.',
    'ambiguous-ordering':
        'Other tags exist, but none of the same variant and precision — we do not recommend a move that changes what your application runs on.',
    eol: 'Every finding is on a release line that ships no more fixes. The move is a base-image migration, not a tag bump.',
}

function NoRecommendationRow({ item }: { item: NoRecommendationItem }) {
    return (
        <TableRow hoverable>
            <TableCell>
                <Link
                    href={`/images/${item.imageId}`}
                    className="font-mono text-xs font-medium text-ink hover:text-accent hover:underline break-all"
                >
                    {item.subject}
                    {item.currentTag && <span className="text-ink-muted">:{item.currentTag}</span>}
                </Link>
                {/* The Cluster column is collapsed below `lg`. */}
                {item.cluster.name && (
                    <span className="block text-[11px] text-ink-muted lg:hidden">{item.cluster.name}</span>
                )}
            </TableCell>
            <TableCell hideBelow="lg" className="text-xs text-ink-secondary">{item.cluster.name ?? '—'}</TableCell>
            <TableCell hideBelow="sm" align="end" className="tabular-nums text-ink-secondary">
                <span className="inline-flex items-center gap-1.5">
                    {item.findings.toLocaleString()}
                    <KevBadge count={item.kev} />
                </span>
            </TableCell>
            <TableCell align="end">
                <TotalRiskChip score={item.risk} />
            </TableCell>
            <TableCell hideBelow="md" className="text-xs text-ink-secondary">
                {REASON_COPY[item.reason]}
                {item.reason === 'eol' && item.eolLines.length > 0 && (
                    <span className="text-ink-muted">
                        {' '}
                        ({item.eolLines.map(l => `${l.releaseLine} since ${l.eolDate}`).join(', ')})
                    </span>
                )}
            </TableCell>
        </TableRow>
    )
}
