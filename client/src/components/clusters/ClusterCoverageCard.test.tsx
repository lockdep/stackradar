import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider';
import { resolveEdition } from '@/lib/edition';
import type { ClusterCoverage } from '@/types/cluster';
import { ClusterCoverageCard, RegistryAuthRemediation } from './ClusterCoverageCard';
import { groupByImage, type UnscannedContainer } from './coverageRemediation';
import { SCANNER_TRUST_LINKS } from './scannerInstall';

/* The whole card, as static markup: the coverage read is stubbed to one
   answer per test and the polling and focus hooks to nothing, so what is
   asserted is the markup for a given coverage, not the fetching. */
let coverage: ClusterCoverage | null = null;
vi.mock('@/hooks', () => ({
    useResource: () => ({ data: coverage, isLoading: false, lastUpdated: null, refetch: async () => {} }),
    usePollWhile: () => {},
    useRevalidateOnFocus: () => {},
}));
vi.mock('./ClusterContext', () => ({
    useCluster: () => ({
        cluster: { id: 'c1', name: 'platform-eu1', scannerVersion: '0.7.0' },
        setClusterName: () => {},
        refetchCluster: async () => {},
    }),
}));

const renderCard = (value: ClusterCoverage | null) => {
    coverage = value;
    return renderToStaticMarkup(
        <RuntimeConfigProvider
            config={{
                scannerChartVersion: '0.7.0',
                publicApiUrl: null,
                demoMode: false,
                edition: resolveEdition('cloud'),
                localLogin: false,
            }}
        >
            <ClusterCoverageCard clusterId="c1" />
        </RuntimeConfigProvider>,
    );
};

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function row(overrides: Partial<UnscannedContainer> = {}): UnscannedContainer {
    return {
        namespace: 'apps',
        workloadName: 'api',
        workloadKind: 'Deployment',
        containerName: 'api',
        imageRef: `registry.example.com/acme/api@${DIGEST_A}`,
        imageDigest: DIGEST_A,
        firstSeenAt: '2026-10-18T19:00:00.000Z',
        lastSeenAt: '2026-10-18T20:00:00.000Z',
        scanErrorCode: 'registry_auth',
        scanErrorHost: 'registry.example.com',
        scanErrorAt: '2026-10-18T19:30:00.000Z',
        imagePullSecrets: null,
        ...overrides,
    };
}

const render = (rows: UnscannedContainer[], install: Parameters<typeof RegistryAuthRemediation>[0]['install']) =>
    renderToStaticMarkup(
        <RegistryAuthRemediation
            groups={groupByImage(rows.map((workload) => ({ workload, status: 'auth_failed' as const })))}
            install={install}
        />,
    );

describe('ClusterCoverageCard', () => {
    it('links the three trust pages, with every container scanned', () => {
        const html = renderCard({ discovered: 2, scanned: 2, reportedAt: '2026-10-18T20:00:00.000Z', workloads: [] });
        expect(html).toContain('Every container the scanner can see has an SBOM.');
        for (const link of SCANNER_TRUST_LINKS) {
            expect(html).toContain(`href="${link.href}"`);
            expect(html).toContain(`${link.label}<`);
        }
        expect(html).toContain('href="https://stackradar.io/docs/architecture#data-leaving"');
        expect(html).toContain('href="https://stackradar.io/docs/architecture#permissions"');
        expect(html).toContain('href="https://stackradar.io/docs/helm-values"');
    });

    it('keeps the links under the remediation when containers are blocked', () => {
        const html = renderCard({
            discovered: 2,
            scanned: 1,
            reportedAt: '2026-10-18T20:00:00.000Z',
            workloads: [row({ imagePullSecrets: ['regcred'] })],
        });
        expect(html).toContain('Registry authentication failed');
        expect(html).toContain('Permissions it needs');
    });

    it('explains a too-large image with the storage limits, never with pull Secrets', () => {
        const html = renderCard({
            discovered: 4,
            scanned: 1,
            reportedAt: '2026-10-18T20:00:00.000Z',
            workloads: [
                row({ imagePullSecrets: ['regcred'] }),
                // A scan still in flight, so the summary has a wait to measure.
                row({
                    workloadName: 'worker',
                    imageDigest: `sha256:${'c'.repeat(64)}`,
                    firstSeenAt: new Date().toISOString(),
                    scanErrorCode: null,
                    scanErrorHost: null,
                    scanErrorAt: null,
                }),
                row({
                    namespace: 'ml',
                    workloadName: 'model-server',
                    containerName: 'server',
                    imageRef: `ghcr.io/acme/model-server@${DIGEST_B}`,
                    imageDigest: DIGEST_B,
                    scanErrorCode: 'image_too_large',
                    scanErrorHost: 'ghcr.io',
                    imagePullSecrets: ['regcred'],
                }),
            ],
        });
        // The auth block is about the one auth row only.
        expect(html).toContain('1 container on 1 image has no SBOM');
        // The too-large row keeps its own label, section and fix.
        expect(html).toContain('Too large to scan');
        expect(html).toContain('aria-label="Too large to scan"');
        expect(html).toContain('watcher.scratchSizeLimit');
        expect(html).toContain('watcher.resources.limits.ephemeral-storage');
        expect(html).toContain('href="https://stackradar.io/docs/helm-values"');
        expect(html).toContain('--version 0.7.0');
        const tooLarge = html.slice(html.indexOf('aria-label="Too large to scan"'));
        const section = tooLarge.slice(0, tooLarge.indexOf('</section>'));
        expect(section).not.toContain('imagePullSecret');
        expect(section).not.toContain('dockerConfigSecret');
        expect(section).not.toContain('credential of its own');
        // It counts against the summary, but not as a registry block.
        expect(html).toContain('1 blocked on registry credentials');
        expect(html).toContain('1 failing');
        expect(html).toContain('1 generating SBOMs');
        // The generic "failing to scan" banner is for the unexplained kind.
        expect(html).not.toContain('The scanner pod logs carry the full');
    });

    it('renders nothing, links included, before the cluster has reported an inventory', () => {
        expect(renderCard(null)).toBe('');
        expect(renderCard({ discovered: null, scanned: null, reportedAt: null, workloads: [] })).toBe('');
    });
});

describe('RegistryAuthRemediation', () => {
    it('names the registry, folds the containers per image and pre-fills the Secret names', () => {
        const html = render(
            [
                row({ workloadName: 'daily-1', imagePullSecrets: ['registry-acme'] }),
                row({ workloadName: 'daily-2', imagePullSecrets: ['registry-acme', 'regcred'] }),
                row({ workloadName: 'site', imageDigest: DIGEST_B, imagePullSecrets: ['regcred'] }),
            ],
            { kind: 'bundled' },
        );
        expect(html).toContain('registry.example.com');
        expect(html).toContain('3 containers on 2 images');
        expect(html).toContain('2 containers in <span class="font-mono">apps</span>');
        // The fix is pre-filled, nested for the bundled subchart, and visible
        // without a click.
        expect(html).toContain('imagePullSecretNames={regcred,registry-acme}');
        expect(html).toContain('scanner.scanner.resolveImagePullSecrets=true');
        expect(html).not.toContain('kubectl get pods');
        // The other path is still reachable, folded.
        expect(html).toContain('credential of its own');
    });

    it('leads with the own-credential path when the pods carry no pull Secret', () => {
        const html = render([row({ imagePullSecrets: [] })], { kind: 'standalone', chartVersion: '0.6.0' });
        expect(html).toContain('carry no pull Secret');
        expect(html).toContain('kubectl create secret docker-registry stackradar-registry');
        expect(html).toContain('--docker-server=registry.example.com');
        expect(html).toContain('--set dockerConfigSecret=stackradar-registry');
        expect(html).toContain('--version 0.6.0');
        expect(html).not.toContain('imagePullSecretNames');
    });

    it('falls back to a per-namespace lookup when the scanner never reported the names', () => {
        const html = render([row(), row({ namespace: 'batch', workloadName: 'job' })], {
            kind: 'standalone',
            chartVersion: null,
        });
        expect(html).toContain('kubectl get pods -n apps');
        expect(html).toContain('kubectl get pods -n batch');
        expect(html).toContain('&lt;secret-name&gt;');
        expect(html).toContain('&lt;chart-version&gt;');
    });
});
