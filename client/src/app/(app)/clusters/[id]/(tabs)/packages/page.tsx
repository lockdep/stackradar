'use client';

import { Suspense } from 'react';
import { LoadingBlock } from '@/components/ui';
import { PackageList, useCluster } from '@/components/clusters';

/**
 * The distinct packages running in one cluster — every library of every
 * scanned image, one row per name + version. The org-wide `/packages` page
 * is the same list over every cluster; see `PackageList`.
 */
export default function ClusterPackagesPage() {
    return (
        /* `useSearchParams` (inside the filter hook) requires a Suspense
           boundary between it and the route shell. */
        <Suspense fallback={<LoadingBlock />}>
            <ClusterPackages />
        </Suspense>
    );
}

function ClusterPackages() {
    const { cluster } = useCluster();

    return (
        <div className="mt-6">
            <PackageList
                apiBase={`/api/clusters/${cluster.id}/components`}
                contextKey={cluster.id}
                clusterId={cluster.id}
                scopeLabel={<>{cluster.name}&apos;s scanned images</>}
                headingLevel="h2"
                ariaLabel="Packages in this cluster"
                emptyText={{
                    filtered: (search) =>
                        search
                            ? `No packages match “${search}” in this cluster.`
                            : 'No packages match the current filter in this cluster.',
                    none: 'No packages yet. They appear here once the scanner uploads an SBOM for an image in this cluster.',
                }}
            />
        </div>
    );
}
