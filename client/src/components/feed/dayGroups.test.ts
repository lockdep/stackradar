import { describe, expect, it } from 'vitest';
import type { FeedEvent } from '@/types/feed';
import { EMPTY_BREAKDOWN, feedWorthy, groupByDay, isFirstScan } from './dayGroups';

/**
 * The feed's read-time rules. What the
 * log records and what the page shows differ in three places, and each is a
 * question the reader did not ask.
 */

let seq = 0;
/* Payloads here are the slice a rule reads, not whole events; the cast is the test's. */
function event(type: FeedEvent['type'], payload: Record<string, unknown>, at = '2026-09-06T15:00:00Z'): FeedEvent {
    seq += 1;
    return {
        id: `e${seq}`,
        orgId: 'org',
        clusterId: 'c1',
        clusterName: 'dev',
        type,
        imageId: 'img',
        issueId: null,
        payload,
        createdAt: at,
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
const A = { imageId: 'a', digest: 'sha256:a', tag: '1.26', ref: 'acme/api@sha256:a' };
const B = { imageId: 'b', digest: 'sha256:b', tag: '1.27', ref: 'acme/api@sha256:b' };

function scan(overrides: Record<string, unknown>) {
    return event('scan.findings-changed', {
        cause: 'mirror',
        replaced: false,
        repository: 'acme/api',
        digest: 'sha256:b',
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
        ...overrides,
    });
}

describe('isFirstScan', () => {
    it('trusts the server when it says so', () => {
        expect(isFirstScan(scan({ cause: 'first-scan' }).payload as never)).toBe(true);
    });

    it('recognises an older first scan by its shape: a scan that kept nothing', () => {
        expect(isFirstScan(scan({ cause: 'upload', unchangedCount: 0, addedCount: 114 }).payload as never)).toBe(true);
        expect(isFirstScan(scan({ cause: 'mirror', unchangedCount: 0, addedCount: 114 }).payload as never)).toBe(true);
        expect(isFirstScan(scan({ cause: 'upload', unchangedCount: 3 }).payload as never)).toBe(false);
        expect(isFirstScan(scan({ cause: 'upload', unchangedCount: 0, replaced: true }).payload as never)).toBe(false);
    });

    it('does not second-guess an event whose server named the cause', () => {
        expect(isFirstScan(scan({ cause: 'mirror', unchangedCount: 0, containers: [] }).payload as never)).toBe(false);
    });
});

describe('feedWorthy', () => {
    it('drops first scans and keeps advisory changes', () => {
        const first = scan({ cause: 'first-scan' });
        const mirror = scan({});
        expect(feedWorthy([first, mirror])).toEqual([mirror]);
    });

    it('folds a rollout into the move that completed it, across days', () => {
        const started = event('container.rollout-started', { ...slot, from: A, to: B }, '2026-09-06T23:58:00Z');
        const moved = event(
            'container.image-changed',
            { ...slot, from: A, to: B, delta: null },
            '2026-09-07T00:03:00Z',
        );
        expect(feedWorthy([moved, started])).toEqual([moved]);
    });

    it('hides Job and CronJob pods starting and stopping, never their image changes', () => {
        const job = { ...slot, workloadKind: 'Job', workloadName: 'migrate-29811600' };
        const started = event('container.appeared', { ...job, from: null, to: B });
        const stopped = event('container.removed', { ...job, from: B, to: null });
        const bumped = event('container.image-changed', {
            ...slot,
            workloadKind: 'CronJob',
            from: A,
            to: B,
            delta: null,
        });
        expect(feedWorthy([stopped, started, bumped])).toEqual([bumped]);
    });

    it('keeps a rollout that has not completed', () => {
        const started = event('container.rollout-started', { ...slot, from: A, to: B });
        const other = event('container.image-changed', { ...slot, containerName: 'sidecar', from: A, to: B });
        expect(feedWorthy([other, started])).toEqual([other, started]);
    });
});

describe('groupByDay', () => {
    it('folds a slot that stopped and restarted on the same digest to its net effect', () => {
        const restart = [
            event('container.appeared', { ...slot, from: null, to: A }, '2026-09-06T11:26:00Z'),
            event('container.removed', { ...slot, from: A, to: null }, '2026-09-06T11:20:00Z'),
        ];
        expect(groupByDay(restart)[0]!.lines).toEqual([]);

        const gone = [event('container.removed', { ...slot, from: A, to: null }, '2026-09-06T11:30:00Z'), ...restart];
        const [day] = groupByDay(gone);
        expect(day!.lines.map((l) => l.event.type)).toEqual(['container.removed']);
        expect(day!.summary).toMatchObject({ containersTracked: 0, containersUntracked: 1 });
    });
});

describe('groupByDay summary', () => {
    it('counts what tracked workloads gained and lost from moves and advisories alike', () => {
        const moved = event('container.image-changed', {
            ...slot,
            from: A,
            to: B,
            delta: {
                resolved: 2,
                introduced: 1,
                unchanged: 10,
                resolvedKev: 0,
                introducedKev: 0,
                resolvedHigh: 1,
                resolvedBySeverity: { ...EMPTY_BREAKDOWN, high: 1, low: 1 },
                introducedBySeverity: { ...EMPTY_BREAKDOWN, medium: 1 },
                riskBefore: 50,
                riskAfter: 40,
                riskChange: -10,
            },
        });
        const tracked = event('container.appeared', { ...slot, workloadName: 'new', from: null, to: B });
        const gone = event('container.removed', { ...slot, workloadName: 'old', from: A, to: null });
        const [day] = groupByDay([scan({}), moved, tracked, gone]);
        expect(day!.summary).toMatchObject({
            containersMoved: 1,
            containersTracked: 1,
            containersUntracked: 1,
            rolloutsInProgress: 0,
            findingsAdded: 2,
            findingsResolved: 2,
            findingsAddedBySeverity: { ...EMPTY_BREAKDOWN, critical: 1, medium: 1 },
            findingsResolvedBySeverity: { ...EMPTY_BREAKDOWN, high: 1, low: 1 },
        });
    });
});
