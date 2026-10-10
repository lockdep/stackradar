'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import {
    Button,
    ErrorBlock,
    LoadingBlock,
    MetricsChartCard,
    DaysFilter,
    RelativeTime,
    SeverityCards,
} from '@/components/ui'
import { useRevalidateOnFocus } from '@/hooks'
import { useOrganization } from '@/components/providers/OrganizationProvider'
import { useRuntimeConfig } from '@/components/providers'
import { getPlanHistoryDays } from '@/components/organization-settings/constants'
import { ClusterCoverageCard } from './ClusterCoverageCard'
import type { MetricsSnapshot } from '@/components/ui'
import type { Container } from '@/types/container'
import { getTotalVulnerabilities } from '@/utils/containerUtils'

interface ClusterMetricsSnapshot extends MetricsSnapshot {
    clusterId: string
    /** Always captured on cluster snapshots — see `cluster_metrics_snapshots.risk_score`. */
    riskScore: number
}

/* Snapshots are computed hourly; anything shorter would refetch identical rows. */
const METRICS_STALE_AFTER_MS = 5 * 60_000


export function ClusterOverviewTab({
    clusterId,
    containers,
    isRefreshing,
    lastUpdated,
    onRefresh,
}: {
    clusterId: string
    containers: Container[]
    /** The live container data's fetch state — what "Updated" and the spinner report. */
    isRefreshing: boolean
    lastUpdated: Date | null
    /** Reloads the containers (and the cluster header); snapshots reload alongside. */
    onRefresh: () => Promise<unknown>
}) {
    const { organization } = useOrganization()
    const { edition } = useRuntimeConfig()
    const [days, setDays] = useState(30)
    const [snapshots, setSnapshots] = useState<ClusterMetricsSnapshot[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [snapshotsUpdated, setSnapshotsUpdated] = useState<Date | null>(null)

    /* Responses are matched against the latest request rather than the latest
       effect run, because the focus revalidator fires outside the effect. */
    const requestId = useRef(0)

    const load = useCallback(async ({ silent = false } = {}) => {
        const id = ++requestId.current
        if (!silent) setIsLoading(true)
        try {
            const response = await fetch(`/api/metrics/clusters/${clusterId}/snapshots?days=${days}`)
            if (!response.ok) throw new Error('Failed to load metrics')
            const data: ClusterMetricsSnapshot[] = await response.json()
            if (id !== requestId.current) return
            setSnapshots(data)
            setSnapshotsUpdated(new Date())
            setError(null)
        } catch {
            // A background refetch that fails leaves the last good render in place.
            if (id === requestId.current && !silent) setError('Failed to load cluster metrics')
        } finally {
            if (id === requestId.current) setIsLoading(false)
        }
    }, [clusterId, days])

    useEffect(() => {
        // Copied into the effect so the cleanup doesn't close over `.current`.
        const inFlight = requestId
        void load()
        // Discard in-flight responses on unmount or a window change.
        return () => { inFlight.current++ }
    }, [load])

    const revalidate = useCallback(() => load({ silent: true }), [load])

    /* Every number on the tab, in one click: the live container rows the
       severity cards are summed from, the cluster header above, and the
       hourly snapshots the trend charts draw. Silent, so a failed reload keeps
       the last good render rather than blanking the page. */
    const handleRefresh = useCallback(
        () => Promise.all([onRefresh(), load({ silent: true })]),
        [onRefresh, load]
    )

    useRevalidateOnFocus(revalidate, {
        lastUpdated: snapshotsUpdated,
        staleAfterMs: METRICS_STALE_AFTER_MS,
        enabled: !isLoading,
    })

    /* Deduplicated by image, and it has to be: the same base image running in
       twelve namespaces is one thing to fix, and summing per container is how
       this card came to report a number that tracked container count instead of
       risk. Matches `metricsRepository.computeCurrentClusterMetrics`, which is
       what the trend chart directly above these cards is drawn from. */
    const severityCounts = useMemo(() => getTotalVulnerabilities(containers), [containers])

    if (isLoading) {
        return (
            <LoadingBlock label="Loading metrics..." />
        )
    }

    if (error) {
        return (
            <ErrorBlock title={error} />
        )
    }

    return (
        <div className="mt-6 space-y-8">
            {/* One filter row, above everything it scopes. It used to sit in the
                SeverityCards header — inside a card, but scoping the trend charts
                below it too — with a duplicate copy next to the Trends heading for
                the case where that card is absent. The select names the window
                in words ("Last 30 days"), which is what makes the X axis
                self-explanatory without an axis title — so no caption repeats it. */}
            <div className="flex items-center justify-end gap-4 border-b border-edge pb-3">
                {/* Same refresh control as the other cluster tabs, in the same
                    place — the top right of the tab's own toolbar row. */}
                <div className="flex flex-wrap items-center justify-end gap-3">
                    <DaysFilter value={days} onChange={setDays} maxDays={getPlanHistoryDays(organization?.plan, edition)} />
                    {lastUpdated && (
                        <span className="hidden text-sm text-ink-muted sm:inline">
                            Updated <RelativeTime date={lastUpdated} />
                        </span>
                    )}
                    <Button
                        variant="secondary"
                        onClick={handleRefresh}
                        loading={isRefreshing}
                        title="Refresh overview"
                        /* `pl-2 pr-2`, not `px-2` — see the note in `Table.tsx`. */
                        className="pl-2 pr-2"
                    >
                        {!isRefreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
                        <span className="sr-only">Refresh</span>
                    </Button>
                </div>
            </div>

            {/* Severity breakdown. Each card deep-links into the
                Vulnerabilities tab pre-filtered to its severity — the list it
                summarises, counting by the same finding unit. */}
            {containers.length > 0 && (
                <SeverityCards
                    snapshots={snapshots}
                    counts={severityCounts}
                    severityHref={severity =>
                        `/clusters/${clusterId}/vulnerabilities?severity=${severity}&tier=all`
                    }
                />
            )}

            {/* Above the trends: severity answers "what is wrong with what we
                scanned", and this answers "did we scan all of it" — which is
                the question that qualifies every number below it. Renders
                nothing at all when the cluster has never reported an
                inventory. */}
            <ClusterCoverageCard clusterId={clusterId} />

            {/* Trend charts */}
            <div>
                <h2 className="mb-3 text-sm font-semibold text-ink-secondary">Trends</h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {/* The headline number: the cluster's unbounded risk sum
                        (ADR 0007). It falls as findings are fixed, which is
                        what makes it a trend rather than a badge — it replaced
                        a static card above the fold that could only say "now". */}
                    <MetricsChartCard
                        title="Radar Score"
                        description="Sum of every finding's 0–100 contribution across scanned images"
                        dataKey="riskScore"
                        data={snapshots}
                        deltaDirection="up-bad"
                        href={`/clusters/${clusterId}/radar-score`}
                        hrefTitle="See which images and findings make up the Radar Score"
                    />
                    <MetricsChartCard
                        title="Vulnerabilities"
                        description="Confirmed findings across all current SBOMs"
                        dataKey="totalVulnerabilities"
                        data={snapshots}
                        deltaDirection="up-bad"
                        overlay="criticalAndHigh"
                        href={`/clusters/${clusterId}/vulnerabilities`}
                        hrefTitle="See all vulnerabilities"
                    />
                    <MetricsChartCard
                        title="Running containers"
                        description="Containers running in the cluster"
                        dataKey="totalWorkloads"
                        data={snapshots}
                        href={`/clusters/${clusterId}/containers`}
                        hrefTitle="See all containers"
                    />
                    <MetricsChartCard
                        title="Packages"
                        description="Unique packages from all current SBOMs"
                        dataKey="totalComponents"
                        data={snapshots}
                        href={`/clusters/${clusterId}/packages`}
                        hrefTitle="See all packages"
                    />
                </div>
            </div>

        </div>
    )
}
