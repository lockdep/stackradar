'use client';

import { Suspense } from 'react';
import { RiskScoreBreakdown, useCluster } from '@/components/clusters';

/**
 * The cluster's Risk Score, taken apart — the Overview chart's number,
 * listed image by image. The org-wide `/risk-score` page is the same
 * component over every cluster.
 */
export default function ClusterRiskScorePage() {
    const { cluster } = useCluster();

    return (
        /* Suspense: the expanded rows' findings lens reads the URL. */
        <Suspense>
            <RiskScoreBreakdown
                apiBase={`/api/clusters/${cluster.id}/risk-score`}
                contextKey={cluster.id}
                clusterId={cluster.id}
                scopeName={cluster.name}
                headingLevel="h2"
                chartOwner="Overview"
                ariaLabel="Risk Score by image in this cluster"
                emptyText="No confirmed vulnerabilities in this cluster’s scanned images — the Risk Score is 0."
                className="mt-6"
            />
        </Suspense>
    );
}
