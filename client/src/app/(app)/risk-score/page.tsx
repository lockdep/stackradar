'use client';

import { Suspense } from 'react';
import { RiskScoreBreakdown } from '@/components/clusters';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { LoadingBlock } from '@/components/ui';

/**
 * `/risk-score` — the Dashboard's headline number, taken apart across every
 * cluster: one row per image, largest share first, each naming its cluster.
 * The Dashboard's Risk Score card links here, the way a cluster Overview's
 * links to its Risk Score tab: the same breakdown, over the org-wide
 * endpoint. Images are cluster-scoped (ADR 0006), so a digest running in two
 * clusters is two rows, and the rows still add up to the org's total.
 */
export default function OrgRiskScorePage() {
    const { organization } = useOrganization();
    if (!organization) return <LoadingBlock />;

    return (
        /* Suspense: the expanded rows' findings lens reads the URL. */
        <Suspense fallback={<LoadingBlock />}>
            <RiskScoreBreakdown
                apiBase="/api/risk-score"
                /* The org id keys expansion and paging state, so switching
                   organizations starts the list afresh. */
                contextKey={organization.id}
                scopeName="This organization"
                headingLevel="h1"
                chartOwner="Dashboard"
                ariaLabel="Risk Score by image across all clusters"
                emptyText="No confirmed vulnerabilities in any cluster’s scanned images — the Risk Score is 0."
            />
        </Suspense>
    );
}
