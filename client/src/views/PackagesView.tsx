'use client';

import { useSearchParams } from 'next/navigation';
import { PackageList } from '@/components/clusters';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { LoadingBlock } from '@/components/ui';

/**
 * `/packages` — every third-party package across every cluster of the
 * organization, one row per name + version. The Dashboard's Packages card
 * links here, the way a cluster Overview's links to its Packages tab: the
 * same list, over the org-wide endpoint.
 *
 * Images are cluster-scoped (ADR 0006), so a digest running in two clusters
 * is two images here: a package in both shows an image spread of two and a
 * cluster spread of two, and the two cluster tabs list it once each.
 *
 * `?search=` seeds the list: the Dashboard's search box lands here with the
 * term already applied, so "find every copy of log4j-core" is one keystroke
 * and one page. Needs a Suspense boundary above it for that read and for the
 * list's images filter.
 */
export function PackagesView() {
    const { organization } = useOrganization();
    const initialSearch = useSearchParams().get('search') ?? '';
    if (!organization) return <LoadingBlock />;

    return (
        <PackageList
            apiBase="/api/components"
            /* The org id keys paging state, so switching organizations starts
               the list afresh rather than showing one org's page over
               another's data. */
            contextKey={organization.id}
            initialSearch={initialSearch}
            scopeLabel="every scanned image in this organization"
            headingLevel="h1"
            ariaLabel="Packages across all clusters"
            emptyText={{
                filtered: (search) =>
                    search
                        ? `No packages match “${search}” in any cluster.`
                        : 'No packages match the current filter in any cluster.',
                none: 'No packages yet. They appear here once a scanner uploads an SBOM for an image in any cluster.',
            }}
        />
    );
}
