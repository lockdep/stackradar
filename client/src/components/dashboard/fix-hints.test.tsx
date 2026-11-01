import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FixCellHint, fixShippedLine, indexFixes, noNewerImageReason, scannedFixCount } from './fix-hints';
import type { FixListItem, FixesResponse, NoRecommendationItem } from '@/types/fixes';

/**
 * The per-image fix hint and the aggregate line over it. Both answer "has a
 * fixed image been scanned here", which is a different question from the
 * row's "is a fix published" — the tests pin the words that keep the two
 * apart, and that the reason a third-party image has no move is still said,
 * in the tooltip.
 */

const move = (overrides: Partial<FixListItem> = {}): FixListItem => ({
    id: 'fix-1',
    kind: 'image',
    measured: true,
    evidence: 'sboms',
    subject: 'docker.io/grafana/loki',
    release: null,
    from: 'v3.4.2',
    to: 'v3.5.0',
    bump: 'minor',
    cluster: { id: 'c-1', name: 'prod' },
    control: 'third-party',
    cleared: { findings: 12, kev: 0, high: 3, introduced: 0 },
    riskRemoved: 40,
    upperBound: null,
    workloads: 1,
    containers: 2,
    images: 1,
    delivery: null,
    target: { type: 'image', imageId: 'img-moved' },
    ...overrides,
});

const noMove = (overrides: Partial<NoRecommendationItem> = {}): NoRecommendationItem => ({
    imageId: 'img-stuck',
    control: 'third-party',
    subject: 'docker.io/library/nginx',
    currentTag: '1.27-alpine',
    cluster: { id: 'c-1', name: 'prod' },
    findings: 4,
    kev: 0,
    risk: 10,
    reason: 'not-measured',
    eolLines: [],
    ...overrides,
});

const response = (fixes: FixListItem[], noRecommendation: NoRecommendationItem[]): FixesResponse => ({
    totals: { upgrades: fixes.length, findingsCleared: 0, kevCleared: 0 },
    fixes,
    noRecommendation,
});

const index = indexFixes(
    response([move()], [noMove(), noMove({ imageId: 'img-built', control: 'built', reason: 'no-candidates' })]),
);

const render = (imageId: string, packageFix?: string | null) =>
    renderToStaticMarkup(<FixCellHint index={index} imageId={imageId} packageFix={packageFix} />);

describe('FixCellHint', () => {
    it('names the newer scanned image, as a link to it, when the upgrade list has a measured move', () => {
        const html = render('img-moved');
        expect(html).toContain('Newer image scanned: v3.5.0');
        expect(html).toContain('href="/images/img-moved"');
        expect(html).toMatch(/title="Newer image scanned: v3\.5\.0 — clears 12 findings, 3 high or critical"/);
        expect(html).not.toContain('Move to');
    });

    it('says "No newer image yet" for a third-party image with no move, with the reason in the tooltip', () => {
        const html = render('img-stuck', 'golang.org/x/net 0.55.0');
        expect(html).toContain('No newer image yet');
        expect(html).not.toContain('Waiting on upstream');
        // The tooltip: the fix is published (named), no newer tag is scanned, and the upgrade list's reason.
        expect(html).toContain('title="' + noNewerImageReason('not-measured', 'golang.org/x/net 0.55.0') + '"');
        expect(noNewerImageReason('not-measured', 'golang.org/x/net 0.55.0')).toBe(
            'The fix is published upstream (golang.org/x/net 0.55.0), but no newer tag of this third-party image has been scanned here yet. A newer version is known, but nothing has scanned what it deploys yet.',
        );
    });

    it('does not claim a published fix in the tooltip when the advisory states none for the image', () => {
        expect(noNewerImageReason('up-to-date', null)).toBe(
            'No newer tag of this third-party image has been scanned here yet. This is already the newest tag of the repository anyone here has scanned, so there is no measured move yet.',
        );
        expect(render('img-stuck', null)).toContain('No newer image yet');
    });

    it('says what to rebuild with for an image the organization builds', () => {
        const html = render('img-built', 'golang.org/x/net 0.55.0');
        expect(html).toContain('Rebuild with');
        expect(html).toContain('golang.org/x/net 0.55.0');
        expect(html).not.toContain('No newer image yet');
    });
});

describe('scannedFixCount', () => {
    it('counts the affected images with a measured move, and nothing else', () => {
        const withUnmeasured = indexFixes(
            response(
                [
                    move(),
                    move({
                        id: 'fix-2',
                        kind: 'chart',
                        measured: false,
                        target: { type: 'image', imageId: 'img-chart' },
                    }),
                ],
                [noMove()],
            ),
        );
        expect(scannedFixCount(withUnmeasured, ['img-moved', 'img-chart', 'img-stuck', 'img-unknown'])).toBe(1);
        expect(scannedFixCount(withUnmeasured, [])).toBe(0);
    });
});

describe('fixShippedLine', () => {
    it('is nothing when no fix is published, whatever the images say', () => {
        expect(fixShippedLine(false, 3, 10)).toBeNull();
        expect(fixShippedLine(false, 0, 0)).toBeNull();
    });

    it('is nothing when there are no affected images to count', () => {
        expect(fixShippedLine(true, 0, 0)).toBeNull();
    });

    it('counts k of N', () => {
        expect(fixShippedLine(true, 3, 10)?.text).toBe('Fix shipped in a scanned image for 3 of 10 affected images');
    });

    it('says none of N, and that it is "yet", rather than "0 of N"', () => {
        expect(fixShippedLine(true, 0, 10)?.text).toBe(
            'Fix shipped in a scanned image for none of the 10 affected images yet',
        );
    });

    it('says all N, and the one image when there is one', () => {
        expect(fixShippedLine(true, 10, 10)?.text).toBe('Fix shipped in a scanned image for all 10 affected images');
        expect(fixShippedLine(true, 1, 1)?.text).toBe('Fix shipped in a scanned image for the affected image');
    });

    it('explains in the tooltip what a scanned fix is and what the rest are missing', () => {
        const line = fixShippedLine(true, 3, 10);
        expect(line?.title).toContain('newer tag or chart of the image has been scanned here');
        expect(line?.title).toContain('whatever upstream has published');
    });
});
