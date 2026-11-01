import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeedEvent } from '@/types/feed';
import { EMPTY_BREAKDOWN } from './dayGroups';
import { IMAGE_HISTORY_EMPTY, ImageHistoryList } from './ImageHistory';

/**
 * The image page's History tab is the Feed scoped to one image, drawn with
 * the Feed's rows. Static markup over the page a `GET /api/feed?image=`
 * would answer: the empty sentence when nothing is recorded, and one row per
 * event — the first scan included, which the Feed page itself drops.
 */

const noop = () => {};
const loaded = { error: null, isLoading: false, isLoadingMore: false, hasMore: false, refresh: noop, loadMore: noop };

let seq = 0;
/* Payloads are the slice a row reads, not whole events; the cast is the test's. */
function event(type: FeedEvent['type'], payload: Record<string, unknown>): FeedEvent {
    seq += 1;
    return {
        id: `e${seq}`,
        orgId: 'org',
        clusterId: 'c1',
        clusterName: 'prod',
        type,
        imageId: 'img-a',
        issueId: null,
        payload,
        createdAt: new Date(Date.now() - seq * 60_000).toISOString(),
    } as unknown as FeedEvent;
}

const slot = {
    namespace: 'prod',
    workloadKind: 'Deployment',
    workloadName: 'web',
    containerName: 'api',
    init: false,
    repository: 'acme/api',
};
const A = { imageId: 'img-a', digest: `sha256:${'a'.repeat(64)}`, tag: '1.26', ref: 'acme/api:1.26' };
const B = { imageId: 'img-b', digest: `sha256:${'b'.repeat(64)}`, tag: '1.27', ref: 'acme/api:1.27' };

const sample: FeedEvent[] = [
    // Newest first, as the server orders them: the move off this image …
    event('container.image-changed', {
        ...slot,
        from: A,
        to: B,
        imageNew: true,
        imageGone: true,
        delta: {
            resolved: 3,
            introduced: 1,
            unchanged: 10,
            resolvedKev: 0,
            introducedKev: 0,
            riskChange: -12,
            resolvedBySeverity: { ...EMPTY_BREAKDOWN, high: 3 },
            introducedBySeverity: { ...EMPTY_BREAKDOWN, low: 1 },
        },
    }),
    // … an advisory that landed while it ran …
    event('scan.findings-changed', {
        cause: 'mirror',
        replaced: false,
        repository: 'acme/api',
        digest: A.digest,
        containers: [slot],
        containerCount: 1,
        addedCount: 1,
        removedCount: 0,
        unchangedCount: 40,
        rescoredCount: 0,
        addedBySeverity: { ...EMPTY_BREAKDOWN, critical: 1 },
        removedBySeverity: { ...EMPTY_BREAKDOWN },
        added: [],
        removed: [],
        riskBefore: 100,
        riskAfter: 190,
    }),
    // … its first scan …
    event('scan.findings-changed', {
        cause: 'first-scan',
        replaced: false,
        repository: 'acme/api',
        digest: A.digest,
        containers: [slot],
        containerCount: 1,
        addedCount: 40,
        removedCount: 0,
        unchangedCount: 0,
        rescoredCount: 0,
        addedBySeverity: { ...EMPTY_BREAKDOWN, high: 2, medium: 38 },
        removedBySeverity: { ...EMPTY_BREAKDOWN },
        added: [],
        removed: [],
        riskBefore: 0,
        riskAfter: 100,
    }),
    // … and the container that first ran it.
    event('container.appeared', { ...slot, from: null, to: A, imageNew: true }),
];

describe('ImageHistoryList', () => {
    it('says so when nothing is recorded for the image', () => {
        const html = renderToStaticMarkup(
            <ImageHistoryList {...loaded} events={[]} served={{ days: 365, historyDays: 365 }} />,
        );
        expect(html).toContain(IMAGE_HISTORY_EMPTY);
        expect(html).not.toContain('aria-label="History of this image"');
    });

    it('draws one Feed row per event, the first scan included', () => {
        const html = renderToStaticMarkup(
            <ImageHistoryList {...loaded} events={sample} served={{ days: 365, historyDays: 365 }} />,
        );
        expect(html).not.toContain(IMAGE_HISTORY_EMPTY);
        expect(html).toContain('aria-label="History of this image"');
        // The slot every row is about, and each row's verb.
        expect(html).toContain('prod/web · api');
        expect(html).toContain('>now tracked<');
        expect(html).toContain('>first scan<');
        expect(html).toContain('>advisories changed<');
        expect(html).toContain('>image changed<');
        // The move names both sides by tag.
        expect(html).toContain('>1.26<');
        expect(html).toContain('>1.27<');
    });

    it('shows the loading state before the first page and the error when it fails', () => {
        const loading = renderToStaticMarkup(<ImageHistoryList {...loaded} isLoading events={null} served={null} />);
        expect(loading).toContain('Loading the history');

        const failed = renderToStaticMarkup(<ImageHistoryList {...loaded} error="boom" events={null} served={null} />);
        expect(failed).toContain('Failed to load the history');
        expect(failed).not.toContain(IMAGE_HISTORY_EMPTY);
    });
});
