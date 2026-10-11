'use client';

import { useSearchParams } from 'next/navigation';
import { VulnerabilityList } from '@/components/clusters';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { LoadingBlock } from '@/components/ui';

/**
 * `/vulnerabilities` — every confirmed vulnerability across every cluster of
 * the organization, one row per advisory. The Dashboard's severity cards
 * link here with the matching filter, the way a cluster Overview's link to
 * its Vulnerabilities tab: the same list, over the org-wide endpoint.
 *
 * Findings are cluster-scoped (ADR 0006), so a digest running in two
 * clusters is two images and counts twice here — exactly as it does in the
 * Dashboard's cards, which is what lets the two numbers agree.
 *
 * `?search=` seeds the list, as it does on `/packages`: the global search
 * palette's "Search vulnerabilities for …" row lands here with the term
 * already applied. Needs the page's Suspense boundary for that read.
 */
export function VulnerabilitiesView() {
    const { organization } = useOrganization();
    const initialSearch = useSearchParams().get('search') ?? '';
    if (!organization) return <LoadingBlock />;

    return (
        <VulnerabilityList
            apiBase="/api/vulnerabilities"
            /* The org id keys expansion and paging state, so switching
               organizations starts the list afresh rather than showing one
               org's expanded rows over another's data. */
            contextKey={organization.id}
            initialSearch={initialSearch}
            scopeLabel="every scanned image in this organization"
            cardsOwner="Dashboard"
            headingLevel="h1"
            ariaLabel="Vulnerabilities across all clusters"
            emptyText={{
                filtered: 'No vulnerabilities match the current filter in any cluster.',
                none: 'No confirmed vulnerabilities in any cluster’s scanned images.',
            }}
        />
    );
}
