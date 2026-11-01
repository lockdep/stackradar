import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Table, TableBody } from '@/components/ui';
import type { Image } from '@/types/container';
import { ImageRow } from './ImageRow';

function image(overrides: Partial<Image> = {}): Image {
    return {
        id: 'img-1',
        digest: 'sha256:' + 'a'.repeat(64),
        clusterId: 'c-1',
        clusterName: 'prod',
        registry: 'docker.io',
        repository: 'nginx',
        metadata: null,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        sbomId: 'sbom-1',
        scannedAt: '2026-01-02T00:00:00.000Z',
        lastMatchedAt: '2026-01-03T00:00:00.000Z',
        componentCount: 12,
        vulnerabilities: { critical: 0, high: 0, medium: 0, low: 0 },
        containerCount: 1,
        tags: ['1.27-alpine'],
        risk: null,
        ...overrides,
    };
}

function render(img: Image) {
    return renderToStaticMarkup(
        <Table aria-label="Images">
            <TableBody>
                <ImageRow image={img} expanded={false} onToggle={() => {}} onControlChange={undefined} />
            </TableBody>
        </Table>,
    );
}

/**
 * The Built column: an age when the scanner reported a usable build date,
 * otherwise a dash that says why on hover — with a dotted underline, so the
 * dash reads as "there is a reason" and not as "nothing to say".
 */
describe('ImageRow Built cell', () => {
    it('defines the dash in a cued tooltip when there is no usable build date', () => {
        const html = render(image());
        expect(html).toMatch(/decoration-dotted[^>]*>—</);
        expect(html).toMatch(/role="tooltip"[^>]*>No usable build date: the scanner did not report one/);
        expect(html).not.toContain('title="No usable build date');
    });

    it('shows the age, not the dash, when the image carries a build date', () => {
        const html = render(image({ metadata: { created: '2026-01-01T00:00:00.000Z' } }));
        expect(html).not.toContain('No usable build date');
        expect(html).toMatch(/title="Built /);
    });
});
