import { describe, expect, it } from 'vitest';
import { mirrorBannerState, mirrorNeedsPolling, type BootstrapProgress, type MirrorStatus } from './mirror-status';

const NOW = Date.parse('2026-10-17T10:00:00Z');

const pending: MirrorStatus = {
    ready: false,
    osv: {
        status: 'pending',
        initialized: false,
        initCompletedAt: null,
        lastError: null,
        ecosystems: null,
        bootstrap: null,
        recordsMirrored: null,
        bootstrapDurationMs: null,
    },
    epss: {
        status: 'pending',
        lastSyncedAt: null,
        runStartedAt: null,
        lastError: null,
        scoreDate: null,
        cvesMatched: null,
    },
    kev: {
        status: 'pending',
        lastSyncedAt: null,
        runStartedAt: null,
        lastError: null,
        catalogVersion: null,
        entriesMatched: null,
    },
};

const progress: BootstrapProgress = {
    startedAt: '2026-10-17T09:55:48.000Z',
    updatedAt: '2026-10-17T09:59:50.000Z',
    archiveIndex: 2,
    archiveCount: 4,
    ecosystem: 'Debian',
    phase: 'importing',
    bytesReceived: 52_428_800,
    contentLength: 52_428_800,
    recordsProcessed: 5000,
    archiveEntries: 12_000,
    recordsFromEarlierArchives: 3000,
    archives: [
        { ecosystem: 'Alpine', records: 3000 },
        { ecosystem: 'Debian', records: null },
        { ecosystem: 'Go', records: null },
        { ecosystem: 'npm', records: null },
    ],
};

function building(s: MirrorBannerStateBuilding | ReturnType<typeof mirrorBannerState>) {
    if (s.kind !== 'building') throw new Error(`expected building, got ${s.kind}`);
    return s;
}
type MirrorBannerStateBuilding = Extract<ReturnType<typeof mirrorBannerState>, { kind: 'building' }>;

describe('mirrorBannerState', () => {
    it('is silent while the status is unknown, and once every feed has landed', () => {
        expect(mirrorBannerState(null, NOW)).toEqual({ kind: 'ready' });
        expect(mirrorBannerState({ ...pending, ready: true }, NOW)).toEqual({ kind: 'ready' });
    });

    it('says the database is being built while the OSV import is still ahead, and which feeds wait on it', () => {
        const s = building(mirrorBannerState(pending, NOW));
        expect(s.tone).toBe('info');
        expect(s.headline).toBe('Vulnerability database is being built.');
        expect(s.feeds.map((f) => f.key)).toEqual(['osv', 'epss', 'kev']);
        expect(s.feeds[0]!.detail).toMatch(/^Not started yet/);
        expect(s.feeds[0]!.bar).toBeNull();
        expect(s.feeds[1]!.detail).toBe('Runs after the OSV import.');
        expect(s.feeds[2]!.detail).toBe('Runs after the OSV import.');
    });

    it('narrates a download with its size and a bar', () => {
        const s = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: {
                        ...pending.osv,
                        status: 'running',
                        bootstrap: { ...progress, phase: 'downloading', bytesReceived: 13_107_200 },
                    },
                },
                NOW,
            ),
        );
        expect(s.feeds[0]!.detail).toBe('Downloading Debian (archive 2 of 4) · 12.5 MB of 50.0 MB · 4m 12s elapsed');
        expect(s.feeds[0]!.bar).toBeCloseTo(0.25, 5);
    });

    it('draws a bar from the first second of a download, before the server has said how big the archive is', () => {
        const fresh = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: {
                        ...pending.osv,
                        status: 'running',
                        bootstrap: { ...progress, phase: 'downloading', bytesReceived: 0, contentLength: null },
                    },
                },
                NOW,
            ),
        );
        expect(fresh.feeds[0]!.detail).toBe('Downloading Debian (archive 2 of 4) · 4m 12s elapsed');
        expect(fresh.feeds[0]!.bar).toBe('indeterminate');

        const sized = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: {
                        ...pending.osv,
                        status: 'running',
                        bootstrap: { ...progress, phase: 'downloading', bytesReceived: 0, contentLength: 52_428_800 },
                    },
                },
                NOW,
            ),
        );
        expect(sized.feeds[0]!.bar).toBe(0);
    });

    it('narrates an import with the archive position, the records and the running total', () => {
        const s = building(
            mirrorBannerState({ ...pending, osv: { ...pending.osv, status: 'running', bootstrap: progress } }, NOW),
        );
        expect(s.feeds[0]!.detail).toBe(
            'Importing Debian (archive 2 of 4) · 5,000 of 12,000 records · 8,000 in total · 4m 12s elapsed',
        );
        expect(s.feeds[0]!.bar).toBeCloseTo(5000 / 12000, 5);
    });

    it('ticks off each ecosystem of a scoped import: done ones by name and count, the current one, the rest waiting', () => {
        const s = building(
            mirrorBannerState({ ...pending, osv: { ...pending.osv, status: 'running', bootstrap: progress } }, NOW),
        );
        expect(s.feeds[0]!.steps).toEqual([
            { label: 'Alpine', status: 'done', detail: '3,000 records' },
            { label: 'Debian', status: 'running', detail: 'Importing' },
            { label: 'Go', status: 'pending', detail: 'Waiting' },
            { label: 'npm', status: 'pending', detail: 'Waiting' },
        ]);
        expect(s.feeds[1]!.steps).toBeNull();
        expect(s.feeds[2]!.steps).toBeNull();

        const publishing = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: {
                        ...pending.osv,
                        status: 'running',
                        bootstrap: {
                            ...progress,
                            phase: 'publishing',
                            archiveIndex: 4,
                            archives: progress.archives.map((a) => ({ ...a, records: a.records ?? 1000 })),
                        },
                    },
                },
                NOW,
            ),
        );
        expect(publishing.feeds[0]!.steps!.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    });

    it('does not mention archives for the single global archive, and reports the publishing tail', () => {
        const single: BootstrapProgress = {
            ...progress,
            archiveIndex: 1,
            archiveCount: 1,
            ecosystem: null,
            recordsFromEarlierArchives: 0,
            archiveEntries: null,
            archives: [{ ecosystem: null, records: null }],
        };
        const importing = building(
            mirrorBannerState({ ...pending, osv: { ...pending.osv, status: 'running', bootstrap: single } }, NOW),
        );
        expect(importing.feeds[0]!.detail).toBe('Importing advisories · 5,000 records · 4m 12s elapsed');
        expect(importing.feeds[0]!.bar).toBe('indeterminate');
        expect(importing.feeds[0]!.steps).toBeNull();

        const publishing = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: { ...pending.osv, status: 'running', bootstrap: { ...single, phase: 'publishing' } },
                },
                NOW,
            ),
        );
        expect(publishing.feeds[0]!.detail).toBe('Publishing the mirror · 5,000 records imported · 4m 12s elapsed');
        expect(publishing.feeds[0]!.bar).toBe(1);
    });

    it('flags an import that has stopped reporting', () => {
        const s = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: {
                        ...pending.osv,
                        status: 'running',
                        bootstrap: { ...progress, updatedAt: '2026-10-17T09:52:00.000Z' },
                    },
                },
                NOW,
            ),
        );
        expect(s.feeds[0]!.detail).toMatch(/no progress reported for 8m; check the server log$/);
    });

    it('says the import is running even before the first progress write', () => {
        const s = building(mirrorBannerState({ ...pending, osv: { ...pending.osv, status: 'running' } }, NOW));
        expect(s.feeds[0]!.detail).toBe('Import running. Progress has not been reported yet.');
        expect(s.feeds[0]!.bar).toBe('indeterminate');
    });

    it('turns to danger when the first import failed and nothing is running', () => {
        const s = building(
            mirrorBannerState(
                { ...pending, osv: { ...pending.osv, status: 'failed', lastError: 'download stalled' } },
                NOW,
            ),
        );
        expect(s.tone).toBe('danger');
        expect(s.headline).toBe('Vulnerability database could not be built yet.');
        expect(s.feeds[0]!.detail).toBe(
            'The first import failed: download stalled. The server retries on its schedule.',
        );
    });

    it('is almost ready once findings are in and the feeds are scoring', () => {
        const s = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: {
                        ...pending.osv,
                        status: 'ready',
                        initialized: true,
                        ecosystems: ['Alpine', 'Debian'],
                        recordsMirrored: 312_480,
                        bootstrapDurationMs: 860_000,
                    },
                    epss: { ...pending.epss, status: 'running', runStartedAt: '2026-10-17T09:58:55.000Z' },
                },
                NOW,
            ),
        );
        expect(s.tone).toBe('info');
        expect(s.headline).toBe('Vulnerability database is almost ready.');
        expect(s.feeds[0]!.detail).toBe('Mirrored: Alpine, Debian · 312,480 records in 14m 20s');
        expect(s.feeds[1]!.bar).toBeNull();
        expect(s.feeds[1]!.detail).toBe('Scoring advisories · 1m 5s elapsed');
        expect(s.feeds[2]!.detail).toBe('Starting shortly.');
    });

    it('turns to danger when findings are in but every outstanding feed has failed', () => {
        const s = building(
            mirrorBannerState(
                {
                    ...pending,
                    osv: { ...pending.osv, status: 'ready', initialized: true },
                    epss: {
                        ...pending.epss,
                        status: 'ready',
                        lastSyncedAt: '2026-10-17T09:59:00.000Z',
                        scoreDate: '2026-10-16',
                        cvesMatched: 41_000,
                    },
                    kev: { ...pending.kev, status: 'failed', lastError: 'HTTP 503' },
                },
                NOW,
            ),
        );
        expect(s.tone).toBe('danger');
        expect(s.headline).toBe('Exploitation data has not loaded.');
        expect(s.feeds[1]!.detail).toBe('Scores from 2026-10-16 · 41,000 CVEs matched');
        expect(s.feeds[2]!.detail).toBe(
            'Failed: HTTP 503. The server retries daily; until then no finding is flagged as known-exploited.',
        );
    });
});

describe('mirrorNeedsPolling', () => {
    it('polls until every feed has landed', () => {
        expect(mirrorNeedsPolling(null)).toBe(false);
        expect(mirrorNeedsPolling(pending)).toBe(true);
        expect(mirrorNeedsPolling({ ...pending, osv: { ...pending.osv, status: 'ready', initialized: true } })).toBe(
            true,
        );
        expect(mirrorNeedsPolling({ ...pending, ready: true })).toBe(false);
    });
});
