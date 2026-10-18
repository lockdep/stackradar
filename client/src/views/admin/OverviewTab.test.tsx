import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider';
import { resolveEdition, type Edition } from '@/lib/edition';
import type { OverviewData } from './types';

/**
 * The Overview's pipeline against an install where three things are wrong
 * at once — the scanner is offline and behind the advertised chart, a job
 * has waited an hour, EPSS is three days old — and the mirror is fine.
 * Static markup, the data hook replaced with the fixture. What is asserted
 * is the plan's acceptance line: each of those is visible on the Overview
 * without opening another tab, in a sentence that says what to do, and the
 * healthy stages do not shout.
 */
vi.mock('next/navigation', () => ({
    usePathname: () => '/admin',
    useRouter: () => ({ push: () => {} }),
    useSearchParams: () => new URLSearchParams(),
}));

const HOUR = 3600_000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const data: OverviewData = {
    stats: {
        organizations: { total: 2, byPlan: { pro: 1, team: 1 } },
        users: { total: 3 },
        jobs: {
            total: 10,
            byStatus: { pending: 1, completed: 9 },
            byType: {},
            health: { oldestPendingAgeSeconds: 3600, last24h: { completed: 9, failed: 0 }, stuckAtMaxRetries: 2 },
        },
        vulnerabilities: {
            total: 1000,
            withdrawn: 3,
            bySeverity: {},
            withoutCvssScore: 0,
            affectedPackagesTotal: 5000,
        },
        sboms: { total: 4 },
        components: { total: 400, withVulnerabilities: 40 },
        images: { total: 6, withSbom: 4, orphaned: 1, awaitingSbom: 1 },
        kubernetes: { clusters: 1, namespaces: 3, workloads: 5, containers: 6, helmReleases: 2 },
    },
    osvState: {
        initialized: true,
        syncStatus: 'idle',
        lastSuccessfulPollAt: iso(HOUR / 2),
        lastModifiedSeen: iso(HOUR / 2),
        lastModifiedApplied: iso(HOUR / 2),
        lastFullRefreshAt: iso(48 * HOUR),
        affectedPkgGeneration: 2,
        consecutiveFailures: 0,
        lastError: null,
        updatedAt: iso(HOUR / 2),
        ecosystems: ['Alpine'],
    },
    pipeline: {
        scanner: {
            minVersion: null,
            clusters: [
                {
                    id: 'cl-1',
                    name: 'prod',
                    orgId: 'org-1',
                    scannerVersion: '0.4.0',
                    scannerLastSeenAt: iso(3 * HOUR),
                    kubernetesVersion: 'v1.31.0',
                    ownerMetadataCollected: false,
                },
            ],
            total: 1,
        },
        inventory: { newestSeenAt: iso(HOUR) },
        sboms: { newestCreatedAt: iso(2 * HOUR) },
    },
    feeds: {
        staleAfterHours: 48,
        epss: {
            state: {
                lastSyncedAt: iso(72 * HOUR),
                lastScoreDate: '2026-10-15',
                rowsInFile: 1,
                rowsMatched: 1,
                rowsUnmatched: 0,
                lastError: null,
                updatedAt: iso(72 * HOUR),
            },
            stale: true,
            advisoriesWithScore: 900,
        },
        kev: {
            state: {
                lastSyncedAt: iso(HOUR),
                catalogVersion: '2026.10.18',
                releasedAt: iso(HOUR),
                entriesInCatalog: 1,
                entriesMatched: 1,
                entriesCleared: 0,
                lastError: null,
                updatedAt: iso(HOUR),
            },
            stale: false,
            advisoriesListed: 100,
        },
        artifactHub: { state: null, stale: true, mirrorPackages: 0, attributions: 0 },
    },
    mirror: {
        ready: true,
        osv: {
            status: 'ready',
            initialized: true,
            initCompletedAt: iso(48 * HOUR),
            lastError: null,
            ecosystems: ['Alpine'],
            bootstrap: null,
            recordsMirrored: 1000,
            bootstrapDurationMs: 60_000,
        },
        epss: {
            status: 'ready',
            lastSyncedAt: iso(72 * HOUR),
            runStartedAt: null,
            lastError: null,
            scoreDate: null,
            cvesMatched: null,
        },
        kev: {
            status: 'ready',
            lastSyncedAt: iso(HOUR),
            runStartedAt: null,
            lastError: null,
            catalogVersion: null,
            entriesMatched: null,
        },
    },
};

vi.mock('./useTabData', () => ({
    useTabData: () => ({ data, isLoading: false, error: null, refetch: () => {}, reloadKey: 0 }),
}));

const { OverviewTab } = await import('./OverviewTab');

function render(edition: Edition) {
    return renderToStaticMarkup(
        <RuntimeConfigProvider
            config={{
                scannerChartVersion: '0.5.0',
                publicApiUrl: null,
                demoMode: false,
                edition: resolveEdition(edition),
                localLogin: true,
            }}
        >
            <OverviewTab refreshKey={0} onLoadingChange={() => {}} />
        </RuntimeConfigProvider>,
    );
}

/** The tile with this label, as its own markup. */
function tile(html: string, label: string): string {
    const start = html.indexOf(`>${label}</p>`);
    if (start === -1) throw new Error(`no tile labelled ${label}`);
    const open = html.lastIndexOf('<div class="rounded-md border', start);
    const end = html.indexOf('<div class="rounded-md border', start);
    return html.slice(open, end === -1 ? undefined : end);
}

describe('OverviewTab pipeline', () => {
    const community = render('community');

    it('shows the one cluster inline, offline, behind the chart, unable to read controllers', () => {
        const t = tile(community, 'Scanner');
        expect(t).toContain('bg-danger-subtle');
        expect(t).toContain('Offline');
        expect(t).toContain('prod');
        expect(t).toContain('href="/clusters/cl-1"');
        expect(t).toContain('chart 0.5.0 is available');
        expect(t).toContain('could not read controllers');
    });

    it('marks the stuck queue and names where the out-of-retries jobs are', () => {
        const t = tile(community, 'Queue');
        expect(t).toContain('bg-danger-subtle');
        expect(t).toContain('1h 0m waiting');
        expect(t).toContain('2 out of retries');
    });

    it('marks the stale feed and leaves the fresh one green', () => {
        expect(tile(community, 'EPSS')).toContain('bg-attention-subtle');
        expect(tile(community, 'EPSS')).toContain('older than 48 hours');
        expect(tile(community, 'KEV')).toContain('bg-success-subtle');
    });

    it('reads the healthy stages as healthy', () => {
        expect(tile(community, 'Inventory')).toContain('bg-success-subtle');
        expect(tile(community, 'OSV mirror')).toContain('Up to date');
        expect(tile(community, 'SBOMs')).toContain('1 awaiting');
    });

    it('keeps the tenant figures off the community page', () => {
        expect(community).toContain('Accounts');
        expect(community).not.toContain('Organizations');
        expect(community).not.toContain('By plan');
    });

    it('counts clusters by health on the cloud and links to the list', () => {
        const cloud = render('cloud');
        const t = tile(cloud, 'Scanners');
        expect(t).toContain('0 of 1 reporting');
        expect(t).toContain('1 offline');
        expect(t).toContain('href="/clusters"');
        expect(cloud).toContain('Tenants');
        expect(cloud).toContain('By plan');
    });
});
