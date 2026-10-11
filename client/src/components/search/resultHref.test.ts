import { describe, expect, it } from 'vitest';
import { imageLabel, packagesSearchHref, resultHref, vulnerabilitiesSearchHref } from './resultHref';

describe('resultHref', () => {
    it('sends a vulnerability to its org page by canonical id', () => {
        expect(
            resultHref({
                kind: 'vulnerability',
                item: {
                    vulnId: 'CVE-2021-44228',
                    identity: 'CVE-2021-44228',
                    severity: 'critical',
                    exploited: true,
                    kev: true,
                    imageCount: 1,
                    workloadCount: 2,
                    containerCount: 3,
                },
            }),
        ).toBe('/vulnerabilities/CVE-2021-44228');
    });

    it('sends a package to the org-wide list with the name applied, encoded', () => {
        expect(
            resultHref({
                kind: 'package',
                item: {
                    name: '@babel/core',
                    type: 'library',
                    purlType: 'npm',
                    versionCount: 1,
                    imageCount: 1,
                    workloadCount: 1,
                    containerCount: 1,
                },
            }),
        ).toBe('/packages?search=%40babel%2Fcore');
    });

    it('sends an image to its page', () => {
        expect(
            resultHref({
                kind: 'image',
                item: {
                    id: 'img-1',
                    registry: null,
                    repository: null,
                    tag: null,
                    clusterId: 'c-1',
                    clusterName: 'prod',
                    lastSeenAt: '2026-09-12T00:00:00Z',
                },
            }),
        ).toBe('/images/img-1');
    });

    it('sends a container hit to its page inside the right cluster', () => {
        expect(
            resultHref({
                kind: 'container',
                item: {
                    workloadId: 'w-1',
                    containerId: 'wc-1',
                    name: 'api',
                    kind: 'Deployment',
                    namespace: 'default',
                    clusterId: 'c-1',
                    clusterName: 'prod',
                },
            }),
        ).toBe('/clusters/c-1/containers/wc-1');
    });

    it('sends a cluster to its page', () => {
        expect(resultHref({ kind: 'cluster', item: { id: 'c-1', name: 'prod' } })).toBe('/clusters/c-1');
    });

    it('builds the two fallback rows with the raw term encoded', () => {
        expect(packagesSearchHref('log4j core')).toBe('/packages?search=log4j%20core');
        expect(vulnerabilitiesSearchHref('CVE-2024')).toBe('/vulnerabilities?search=CVE-2024');
    });

    it('labels an image with whatever parts it has', () => {
        expect(imageLabel({ registry: 'ghcr.io', repository: 'acme/app', tag: '1.2.3' })).toBe(
            'ghcr.io/acme/app:1.2.3',
        );
        expect(imageLabel({ registry: null, repository: 'nginx', tag: null })).toBe('nginx');
        expect(imageLabel({ registry: null, repository: null, tag: 'latest' })).toBe('image:latest');
    });
});
