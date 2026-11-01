import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AffectedImagesTable } from './AffectedImagesTable';
import { EMPTY_FIX_INDEX } from '@/components/dashboard/fix-hints';
import type { VulnerabilityOccurrences } from '@/types/cluster';

type AffectedImage = VulnerabilityOccurrences['images'][number];

function image(overrides: Partial<AffectedImage> & Pick<AffectedImage, 'id'>): AffectedImage {
    return {
        registry: 'quay.io',
        repository: 'argoproj/argocd',
        digest: 'sha256:' + 'a'.repeat(64),
        clusterId: 'cl-1',
        clusterName: 'platform-eu1',
        containerCount: 2,
        packages: [],
        ...overrides,
    };
}

const render = (images: AffectedImage[]) =>
    renderToStaticMarkup(
        <AffectedImagesTable
            images={images}
            error={null}
            vulnId="CVE-2024-0001"
            packages={[]}
            fixIndex={EMPTY_FIX_INDEX}
        />,
    );

/**
 * The unfolded row says where each image runs, beside how many containers:
 * the namespace used to be a click into the image and a tab away.
 */
describe('AffectedImagesTable — the namespaces cell', () => {
    it('lists each image’s namespaces, muted, as "argocd, monitoring"', () => {
        const html = render([image({ id: 'i-1', namespaces: ['argocd', 'monitoring'] })]);
        expect(html).toContain('>Namespaces<');
        expect(html).toMatch(
            /<span title="Namespaces running this image: argocd, monitoring">argocd, monitoring<\/span>/,
        );
    });

    it('draws a dash for an image nothing runs', () => {
        const html = render([image({ id: 'i-1', namespaces: [], containerCount: 0 })]);
        expect(html).toContain('>Namespaces<');
        expect(html).not.toContain('Namespaces running this image');
    });

    it('leaves the column out when the server sends no namespaces at all', () => {
        const html = render([image({ id: 'i-1' })]);
        expect(html).not.toContain('>Namespaces<');
    });
});
