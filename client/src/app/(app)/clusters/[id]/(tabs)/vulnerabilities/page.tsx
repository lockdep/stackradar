'use client';

import { Suspense } from 'react';
import { LoadingBlock } from '@/components/ui';
import { VulnerabilityList, useCluster } from '@/components/clusters';

/**
 * Every vulnerability in one cluster — `VulnerabilityList` over the cluster's
 * endpoint. The org-wide Vulnerabilities page is the same list over
 * `/api/vulnerabilities`; the two differ only in scope.
 */
export default function ClusterVulnerabilitiesPage() {
    return (
        /* `useSearchParams` (inside the filter hook) requires a Suspense
           boundary between it and the route shell. */
        <Suspense fallback={<LoadingBlock />}>
            <ClusterVulnerabilities />
        </Suspense>
    );
}

function ClusterVulnerabilities() {
    const { cluster } = useCluster();

    return (
        <div className="mt-6">
            <VulnerabilityList
                apiBase={`/api/clusters/${cluster.id}/vulnerabilities`}
                contextKey={cluster.id}
                clusterId={cluster.id}
                scopeLabel={<>{cluster.name}&apos;s scanned images</>}
                cardsOwner="Overview"
                headingLevel="h2"
                ariaLabel="Vulnerabilities in this cluster"
                emptyText={{
                    filtered: 'No vulnerabilities match the current filter in this cluster.',
                    none: 'No confirmed vulnerabilities in this cluster’s scanned images.',
                }}
            />
        </div>
    );
}
