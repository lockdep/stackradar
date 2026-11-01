import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Image, ImageDeployment } from '@/types/container';

/**
 * The image page used to show three numbers for one word: the tab's count
 * (the four bands, no unscored, no lens), the list's badge (findings under
 * the lens, unscored included) and the sentence's advisory count. The tab
 * carries no number now — the list's badge directly under it is the one
 * findings figure — while the Deployments tab keeps its row count. Static
 * markup: the fetch hooks are stubbed to answer the image, and the list
 * under the tab (which reads the URL and the org) is stubbed out.
 */
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: () => {}, back: () => {}, replace: () => {} }),
    usePathname: () => '/images/img-1',
    useSearchParams: () => new URLSearchParams(),
}));

const deployment = (containerName: string, init: boolean): ImageDeployment => ({
    containerId: `c-${containerName}`,
    containerName,
    init,
    imageTag: '2.9.0',
    imageRef: 'quay.io/argoproj/argocd:2.9.0',
    runningPods: 1,
    workloadId: 'w-1',
    workloadName: 'argocd-repo-server',
    workloadKind: 'Deployment',
    namespaceId: 'ns-1',
    namespaceName: 'argocd',
    clusterId: 'cl-1',
    releaseId: null,
    applicationId: null,
});

const image: Image & { deployments: ImageDeployment[] } = {
    id: 'img-1',
    digest: 'sha256:' + 'a'.repeat(64),
    clusterId: 'cl-1',
    clusterName: 'prod',
    registry: 'quay.io',
    repository: 'argoproj/argocd',
    control: 'third-party',
    firstSeenAt: '2026-01-01T00:00:00Z',
    sbomId: 'sbom-1',
    scannedAt: '2026-01-01T00:00:00Z',
    lastMatchedAt: '2026-01-02T00:00:00Z',
    componentCount: 120,
    vulnerabilities: { critical: 3, high: 10, medium: 20, low: 525 },
    containerCount: 2,
    tags: ['2.9.0'],
    risk: { score: 120, band: 'critical', findingCount: 558, kevCount: 0, exploitedCount: 0, topFinding: null },
    deployments: [deployment('init', true), deployment('main', false)],
};

vi.mock('@/hooks', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/hooks')>()),
    useResource: (url: string | null) => ({
        data: url === '/api/images/img-1' ? image : null,
        error: null,
        isLoading: false,
        isRefreshing: false,
        lastUpdated: null,
        refetch: async () => {},
    }),
}));
vi.mock('@/components/clusters', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/clusters')>()),
    VulnerabilityList: () => <p>the list, with its own findings badge</p>,
}));

const { ImageDetailView } = await import('./ImageDetailView');

describe('ImageDetailView — the tab strip', () => {
    const html = renderToStaticMarkup(<ImageDetailView imageId="img-1" />);
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
    const counter = /<span class="rounded-full[^"]*">(\d+)<\/span>/;

    it('puts no count on the Vulnerabilities tab — the list under it carries the one findings figure', () => {
        const vulnerabilities = tabs.find((tab) => tab.includes('>Vulnerabilities<'));
        expect(vulnerabilities).toBeDefined();
        expect(vulnerabilities).not.toMatch(counter);
        // The banded sum this view knows (558) appears nowhere as a tab count.
        expect(html).not.toMatch(/<span class="rounded-full[^"]*">558<\/span>/);
    });

    it('names the places tab "Workloads" — it lists StatefulSets too — and keeps its row count', () => {
        const workloads = tabs.find((tab) => tab.includes('>Workloads<'));
        expect(workloads).toBeDefined();
        expect(workloads?.match(counter)?.[1]).toBe('2');
        expect(tabs.some((tab) => tab.includes('>Deployments<'))).toBe(false);
    });

    it('ends with a History tab — the Feed scoped to this image — after Vulnerabilities and Workloads', () => {
        const names = tabs.map((tab) => tab.match(/>([^<>]+)<\/span>/)?.[1]);
        expect(names.at(-1)).toBe('History');
        expect(names.indexOf('Vulnerabilities')).toBeLessThan(names.indexOf('Workloads'));
        expect(names.indexOf('Workloads')).toBeLessThan(names.indexOf('History'));
        // No count: the tab is a timeline, not a list with a size.
        expect(tabs.at(-1)).not.toMatch(counter);
    });
});

describe('ImageDetailView — the "Runs in" line', () => {
    it('says namespaces, workload count and cluster under the title, as one link to the Workloads tab', () => {
        const html = renderToStaticMarkup(<ImageDetailView imageId="img-1" />);
        // Two containers of one Deployment in one namespace: one workload, one namespace.
        expect(html).toContain('Runs in <button');
        expect(html).toContain('argocd · 1 workload · prod</button>');
        expect(html).toContain('title="Open the Workloads tab — every workload running this image"');
    });
});
