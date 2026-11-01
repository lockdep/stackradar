import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Cluster, SeverityTierCounts } from '@/types/cluster';
import type { Container } from '@/types/container';
import { SCOPE_CHIP_TITLE } from '@/components/dashboard/ScopeChip';

/**
 * The Clusters section of the Dashboard, as static markup: the rows' counts
 * are under the page's lens — the server's per-cluster split where it has
 * arrived, the live sum from the container rows only under "All findings"
 * — and the header wears the same chip as the exposure strip. `useNow`
 * schedules re-renders in an effect, which static markup never runs; the
 * link components need no router.
 */
vi.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push: () => {} }),
}));

const { ClusterSummarySection, lensedSeverity } = await import('./ClusterSummarySection');

const cluster = (id: string, name: string): Cluster => ({
    id,
    name,
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    hasApiKey: true,
    scannerVersion: '0.7.0',
    scannerLastSeenAt: new Date().toISOString(),
    kubernetesVersion: null,
    discoveredWorkloads: 1,
    scannedWorkloads: 1,
    inventoryReportedAt: null,
    registryAuthFailedHosts: [],
    registryAuthFailedWorkloads: 0,
    ownerMetadataCollected: null,
    risk: { score: 120, band: 'critical', findingCount: 12, kevCount: 0, exploitedCount: 0, topFinding: null },
});

const container = (
    clusterId: string,
    imageId: string,
    vulnerabilities: { critical: number; high: number; medium: number; low: number },
): Container => ({
    id: `${clusterId}-${imageId}`,
    name: 'app',
    init: false,
    imageTag: '1.0.0',
    imageRef: `ghcr.io/acme/${imageId}:1.0.0`,
    runningPods: 1,
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    workloadId: `w-${imageId}`,
    workloadName: 'api',
    workloadKind: 'Deployment',
    workloadLabels: null,
    namespaceId: 'ns',
    namespaceName: 'default',
    clusterId,
    releaseId: null,
    releaseName: null,
    chartName: null,
    chartVersion: null,
    applicationId: null,
    applicationName: null,
    imageId,
    imageDigest: `sha256:${imageId}`,
    registry: 'ghcr.io',
    repository: `acme/${imageId}`,
    sbomId: 'sbom',
    scannedAt: '2026-01-01T00:00:00Z',
    lastMatchedAt: null,
    componentCount: 10,
    vulnerabilities,
    fixableComponents: null,
    risk: null,
});

const clusters = [cluster('a', 'prod'), cluster('b', 'staging')];
/* Cluster a: one image with 359 criticals in every bucket; cluster b: 40. */
const containers = [
    container('a', 'img-1', { critical: 359, high: 10, medium: 5, low: 1 }),
    container('b', 'img-2', { critical: 40, high: 2, medium: 0, low: 0 }),
];
const zero = { application: 0, base: 0, all: 0 };
const split: SeverityTierCounts = {
    critical: { application: 300, base: 92, all: 399 },
    high: { application: 12, base: 0, all: 12 },
    medium: zero,
    low: zero,
    byCluster: {
        a: {
            critical: { application: 262, base: 90, all: 359 },
            high: { application: 10, base: 0, all: 10 },
            medium: { application: 5, base: 0, all: 5 },
            low: { application: 1, base: 0, all: 1 },
        },
        b: {
            critical: { application: 38, base: 2, all: 40 },
            high: { application: 2, base: 0, all: 2 },
            medium: zero,
            low: zero,
        },
    },
};

/** The four counts of one cluster row, read off the `dd` cells' titles. */
function countsOf(html: string, clusterName: string): string[] {
    const row = html.split('<li').find((li) => li.includes(clusterName));
    if (!row) throw new Error(`no row for ${clusterName}`);
    return [...row.matchAll(/<dd title="([^"]+)"/g)].map((m) => m[1]!);
}

describe('lensedSeverity', () => {
    const live = { critical: 359, high: 10, medium: 5, low: 1 };

    it('reads the server’s per-cluster split under the lens when it has arrived', () => {
        expect(lensedSeverity('a', live, 'application', split)).toEqual({ critical: 262, high: 10, medium: 5, low: 1 });
        expect(lensedSeverity('a', live, 'base', split)).toEqual({ critical: 90, high: 0, medium: 0, low: 0 });
        expect(lensedSeverity('a', live, 'all', split)).toEqual(live);
    });

    it('counts zero for a cluster the split has no entry for — nothing found there', () => {
        expect(lensedSeverity('idle', live, 'application', split)).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });

    it('stands the live sum in only under All while the split is on its way; under a lens it waits', () => {
        expect(lensedSeverity('a', live, 'all', undefined)).toEqual(live);
        expect(lensedSeverity('a', live, 'application', undefined)).toBeNull();
    });

    it('falls back to the live sum for a server that sends no split at all', () => {
        const withoutSplit = { critical: split.critical, high: split.high, medium: split.medium, low: split.low };
        expect(lensedSeverity('a', live, 'application', withoutSplit)).toEqual(live);
    });
});

describe('ClusterSummarySection', () => {
    it('shows each cluster’s counts under the page’s lens from the server’s split', () => {
        const html = renderToStaticMarkup(
            <ClusterSummarySection
                clusters={clusters}
                containers={containers}
                lens="application"
                control="all"
                lensedCounts={split}
            />,
        );
        expect(countsOf(html, 'prod')).toEqual(['262 critical', '10 high', '5 medium', '1 low']);
        expect(countsOf(html, 'staging')).toEqual(['38 critical', '2 high', '0 medium', '0 low']);
    });

    it('sums the live container rows under All findings before the split arrives', () => {
        const html = renderToStaticMarkup(
            <ClusterSummarySection
                clusters={clusters}
                containers={containers}
                lens="all"
                control="all"
                lensedCounts={undefined}
            />,
        );
        expect(countsOf(html, 'prod')).toEqual(['359 critical', '10 high', '5 medium', '1 low']);
        expect(html).not.toContain('aria-busy="true"');
    });

    it('holds the rows’ shape with placeholders under a lens while the split is on its way', () => {
        const html = renderToStaticMarkup(
            <ClusterSummarySection
                clusters={clusters}
                containers={containers}
                lens="application"
                control="all"
                lensedCounts={undefined}
            />,
        );
        expect(html.match(/aria-busy="true"/g)).toHaveLength(2);
        expect(html).not.toContain('359');
        expect(html).toContain('prod');
    });

    it('wears the exposure strip’s chip in its header, in the filter bar’s words', () => {
        const html = renderToStaticMarkup(
            <ClusterSummarySection
                clusters={clusters}
                containers={containers}
                lens="application"
                control="yours"
                lensedCounts={split}
            />,
        );
        expect(html).toContain(`title="${SCOPE_CHIP_TITLE}"`);
        expect(html).toContain('Application findings · organization images');
    });
});
