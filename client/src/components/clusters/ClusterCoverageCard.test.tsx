import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RegistryAuthRemediation } from './ClusterCoverageCard';
import { groupByImage, type UnscannedContainer } from './coverageRemediation';

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
