import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Table } from '@/components/ui';
import type { ClusterPackagesResponse, PackageOccurrences } from '@/types/cluster';
import { PackageOccurrencesTables } from './PackageExpandedPanel';
import { PackageRows } from './PackageRows';
import { packageRowKey } from './package-focus';

type Package = ClusterPackagesResponse['packages'][number];

function pkg(overrides: Partial<Package> = {}): Package {
    return {
        name: 'libxml2',
        version: '2.13.9-r0',
        purl: 'pkg:apk/alpine/libxml2@2.13.9-r0',
        packageType: 'apk',
        packageLanguage: null,
        license: 'MIT',
        imageCount: 2,
        workloadCount: 3,
        containerCount: 3,
        clusterCount: 1,
        vulnCounts: { critical: 1, high: 0, medium: 2, low: 0 },
        kevCount: 0,
        ...overrides,
    };
}

const CONTEXT = 'org-1';

function render(packages: Package[], expanded: string[] = [], showClusters = true) {
    return renderToStaticMarkup(
        <Table aria-label="Packages across all clusters" density="condensed">
            <PackageRows
                packages={packages}
                apiBase="/api/components"
                contextKey={CONTEXT}
                control="all"
                showClusters={showClusters}
                expanded={new Set(expanded.map((key) => `${CONTEXT}|${key}`))}
                onToggle={() => {}}
            />
        </Table>,
    );
}

describe('PackageRows', () => {
    it('renders a folded row as an expander with link-styled count cells and no panel', () => {
        const html = render([pkg()]);

        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('Expand details for libxml2 2.13.9-r0');
        // The count cells are the popover's trigger, drawn as a link: accent
        // colour, underline on hover — what makes the drill-down discoverable.
        expect(html).toMatch(
            /<button[^>]*class="[^"]*text-accent[^"]*hover:underline[^"]*"[^>]*aria-label="2 images with libxml2 2\.13\.9-r0 — show which"/,
        );
        expect(html).toMatch(/aria-label="3 containers with libxml2 2\.13\.9-r0 — show which"/);
        // Nothing unfolded.
        expect(html).not.toContain('Vulnerabilities in libxml2');
        expect(html).not.toContain('Loading where it runs');
    });

    it('unfolds the row in the expanded set into the panel, under the row', () => {
        const html = render(
            [pkg(), pkg({ name: 'zlib', version: '1.3.1-r2' })],
            [packageRowKey('libxml2', '2.13.9-r0')],
        );

        // One open, one closed, in that order.
        expect(html).toMatch(/aria-expanded="true"[\s\S]*aria-expanded="false"/);
        expect(html).toContain('Collapse details for libxml2 2.13.9-r0');
        expect(html).toContain('Expand details for zlib 1.3.1-r2');
        // The panel: the package's identity, the way to its findings, and the
        // occurrences still loading (no fetch runs in static markup).
        expect(html).toContain('pkg:apk/alpine/libxml2@2.13.9-r0');
        expect(html).toContain('href="/vulnerabilities?search=libxml2"');
        expect(html).toContain('Loading where it runs');
        // The panel comes once, under the libxml2 row and before zlib's.
        expect(html.indexOf('Loading where it runs')).toBeLessThan(html.indexOf('Expand details for zlib'));
    });

    it('gives every row a DOM id a deep link can scroll to, keyed like the server groups', () => {
        const html = render([pkg({ version: null })]);
        expect(html).toContain(`id="package-row-${encodeURIComponent(packageRowKey('libxml2', null))}"`);
        // A versionless row shows a dash for the container count's sibling, never "0".
        expect(html).toContain('Expand details for libxml2"');
    });

    it('draws the Clusters cell only on the org-wide list', () => {
        expect(render([pkg()], [], true)).toContain('Clusters with at least one image carrying this version');
        expect(render([pkg()], [], false)).not.toContain('Clusters with at least one image carrying this version');
    });
});

describe('PackageOccurrencesTables', () => {
    const data: PackageOccurrences = {
        images: [
            {
                id: 'img-1',
                registry: 'docker.io',
                repository: 'nginx',
                digest: `sha256:${'a'.repeat(64)}`,
                clusterId: 'c-1',
                clusterName: 'prod',
            },
            {
                id: 'img-2',
                registry: null,
                repository: null,
                digest: `sha256:${'b'.repeat(64)}`,
                clusterId: 'c-2',
                clusterName: 'staging',
            },
        ],
        workloads: [
            {
                containerId: 'wc-1',
                workloadName: 'web',
                workloadKind: 'Deployment',
                namespaceName: 'e2e-web',
                clusterId: 'c-1',
                clusterName: 'prod',
            },
        ],
    };

    it('lists the images and the containers with image, namespace and cluster, each linked to its page', () => {
        const html = renderToStaticMarkup(
            <PackageOccurrencesTables data={data} label="libxml2 2.13.9-r0" showClusters />,
        );

        expect(html).toContain('aria-label="Images carrying libxml2 2.13.9-r0"');
        expect(html).toContain('href="/images/img-1"');
        expect(html).toContain('docker.io/nginx');
        // A nameless image is named by its digest.
        expect(html).toContain('href="/images/img-2"');
        expect(html).toContain('bbbbbbbbbbbb');
        expect(html).toContain('2 images carry it');

        expect(html).toContain('aria-label="Containers running libxml2 2.13.9-r0"');
        expect(html).toContain('href="/clusters/c-1/containers/wc-1"');
        expect(html).toContain('e2e-web');
        expect(html).toContain('Deployment');
        expect(html).toContain('1 workload runs it');
        // The cluster column, both tables.
        expect(html).toContain('staging');
        expect(html.match(/>prod</g)).toHaveLength(2);
    });

    it('leaves the cluster out on a cluster tab, and says so when nothing runs the package', () => {
        const html = renderToStaticMarkup(
            <PackageOccurrencesTables
                data={{ images: data.images, workloads: [] }}
                label="libxml2 2.13.9-r0"
                showClusters={false}
            />,
        );
        expect(html).not.toContain('>prod<');
        expect(html).not.toContain('>Cluster<');
        expect(html).toContain('Not running anywhere yet');
    });
});
