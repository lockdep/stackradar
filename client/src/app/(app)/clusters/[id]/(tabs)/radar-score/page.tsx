'use client';

import { Suspense } from 'react';
import { RadarScoreBreakdown, useCluster } from '@/components/clusters';

/**
 * The cluster's Radar Score, taken apart — the Overview chart's number,
 * listed image by image. The org-wide `/radar-score` page is the same
 * component over every cluster.
 */
export default function ClusterRadarScorePage() {
    const { cluster } = useCluster();

    return (
        /* Suspense: the expanded rows' findings lens reads the URL. */
        <Suspense>
            <RadarScoreBreakdown
                apiBase={`/api/clusters/${cluster.id}/radar-score`}
                contextKey={cluster.id}
                clusterId={cluster.id}
                scopeName={cluster.name}
                headingLevel="h2"
                chartOwner="Overview"
                ariaLabel="Radar Score by image in this cluster"
                emptyText="No confirmed vulnerabilities in this cluster’s scanned images — the Radar Score is 0."
                className="mt-6"
            />
        </Suspense>
    );
}
