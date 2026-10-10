'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ClusterEmptyState, ClusterOverviewTab, useCluster, useClusterContainers } from '@/components/clusters'
import { ContainersError, ContainersLoading } from '@/components/containers'

/**
 * Overview lives at the cluster index rather than at `/overview`: no redirect,
 * so no flash, and `/clusters/[id]` stays a valid shareable link.
 */
function ClusterOverviewPageContent() {
    const { cluster, refetchCluster } = useCluster()
    const { containers, isLoading, error, isRefreshing, lastUpdated, handleRefresh } = useClusterContainers()
    const justInstalled = useSearchParams().get('justInstalled') === '1'

    if (isLoading) return <ContainersLoading />
    if (error) return <ContainersError error={error} onRetry={handleRefresh} />

    /* Charts of nothing tell a new user nothing. Until the scanner has uploaded
       its first SBOM, Overview shows the same install/waiting panel Containers
       does — the page they land on first should be the one that unblocks them. */
    if (containers.length === 0) return <ClusterEmptyState justInstalled={justInstalled} />

    return (
        <ClusterOverviewTab
            clusterId={cluster.id}
            containers={containers}
            isRefreshing={isRefreshing}
            lastUpdated={lastUpdated}
            onRefresh={() => Promise.all([handleRefresh(), refetchCluster()])}
        />
    )
}

export default function ClusterOverviewPage() {
    return (
        <Suspense fallback={<ContainersLoading />}>
            <ClusterOverviewPageContent />
        </Suspense>
    )
}
