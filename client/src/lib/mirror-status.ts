/**
 * What the app shell says about the three vulnerability feeds, from the
 * server's `GET /api/vulnerabilities/mirror` (`server/src/lib/mirror-status.ts`,
 * whose `MirrorStatus` this mirrors by hand — `scripts/check-cross-app-constants.mjs`
 * keeps the two in step).
 *
 * A fresh self-hosted install bootstraps its OSV mirror in the background
 * after the server is already answering, then scores it with EPSS and KEV:
 * the dashboard is reachable, uploads are accepted, and every image shows
 * zero findings until the bootstrap publishes its first generation — and
 * every Radar Score is still about to move until the two feeds have run.
 * Saying so on every page, feed by feed, is what keeps "no findings yet"
 * from reading as "no vulnerabilities", and what spares a person the server
 * log when they want to know whether the import is moving. Pure, so the
 * wording is unit-tested without a fetch.
 */

import { formatDuration } from '@/utils/formatters';

export type FeedStatus = 'pending' | 'running' | 'failed' | 'ready';

/** A running OSV bootstrap's position (`osv_sync_state.bootstrap_progress`). */
export interface BootstrapProgress {
    startedAt: string;
    updatedAt: string;
    archiveIndex: number;
    archiveCount: number;
    ecosystem: string | null;
    phase: 'downloading' | 'importing' | 'publishing';
    bytesReceived: number;
    contentLength: number | null;
    recordsProcessed: number;
    archiveEntries: number | null;
    recordsFromEarlierArchives: number;
    /** The run's plan in import order; `records` is set once an archive is in. */
    archives: BootstrapArchive[];
}

export interface BootstrapArchive {
    ecosystem: string | null;
    records: number | null;
}

export interface MirrorStatus {
    ready: boolean;
    osv: {
        status: FeedStatus;
        initialized: boolean;
        initCompletedAt: string | null;
        lastError: string | null;
        ecosystems: string[] | null;
        bootstrap: BootstrapProgress | null;
        recordsMirrored: number | null;
        bootstrapDurationMs: number | null;
    };
    epss: {
        status: FeedStatus;
        lastSyncedAt: string | null;
        runStartedAt: string | null;
        lastError: string | null;
        scoreDate: string | null;
        cvesMatched: number | null;
    };
    kev: {
        status: FeedStatus;
        lastSyncedAt: string | null;
        runStartedAt: string | null;
        lastError: string | null;
        catalogVersion: string | null;
        entriesMatched: number | null;
    };
}

/** One row of the banner: a feed, where it is, and a bar when there is one to draw. */
export interface FeedLine {
    key: 'osv' | 'epss' | 'kev';
    name: string;
    /** What the feed contributes, for a reader who has not met the acronym. */
    role: string;
    status: FeedStatus;
    detail: string;
    /**
     * The bar under the line: 0–1 when the current step's size is known,
     * `indeterminate` while work is in progress but nothing has sized it yet
     * (the first seconds of a download, an archive whose entry count is not
     * in), null draws none. A running feed always has a bar — one that
     * appears a few seconds in reads as a stall before it.
     */
    bar: number | 'indeterminate' | null;
    /**
     * The feed's work ticked off item by item — the OSV import's ecosystems,
     * one per archive — so a reader sees what is in as well as what is in
     * flight. Null when the feed is one indivisible step.
     */
    steps: FeedStep[] | null;
}

export interface FeedStep {
    label: string;
    status: 'done' | 'running' | 'pending';
    /** Where the step is, in a word or two: its record count once done, its phase while running. */
    detail: string;
}

export type MirrorBannerState =
    /** Every feed has landed. Nothing to say. */
    | { kind: 'ready' }
    | {
          kind: 'building';
          /** `danger` when nothing is running and something has failed; `info` while work is in progress. */
          tone: 'info' | 'danger';
          headline: string;
          summary: string;
          feeds: FeedLine[];
      };

/** A bootstrap that has written nothing in this long is stuck, or its process is gone. */
const PROGRESS_STALE_AFTER_MS = 5 * 60_000;

const num = (n: number): string => n.toLocaleString('en-US');

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const elapsed = (since: string, now: number): string => formatDuration(Math.max(0, now - new Date(since).getTime()));

function osvLine(osv: MirrorStatus['osv'], now: number): FeedLine {
    const line = { key: 'osv' as const, name: 'OSV.dev', role: 'Advisory mirror', status: osv.status, steps: null };
    switch (osv.status) {
        case 'ready': {
            const parts = [osv.ecosystems ? `Mirrored: ${osv.ecosystems.join(', ')}` : 'Mirrored: every ecosystem'];
            if (osv.recordsMirrored != null) {
                parts.push(
                    osv.bootstrapDurationMs != null
                        ? `${num(osv.recordsMirrored)} records in ${formatDuration(osv.bootstrapDurationMs)}`
                        : `${num(osv.recordsMirrored)} records`,
                );
            }
            return { ...line, detail: parts.join(' · '), bar: null };
        }
        case 'failed':
            return {
                ...line,
                detail: `The first import failed: ${osv.lastError ?? 'unknown error'}. The server retries on its schedule.`,
                bar: null,
            };
        case 'pending':
            return {
                ...line,
                detail: 'Not started yet. The server begins the first import as soon as it is up.',
                bar: null,
            };
        case 'running': {
            const b = osv.bootstrap;
            if (!b) {
                return { ...line, detail: 'Import running. Progress has not been reported yet.', bar: 'indeterminate' };
            }

            const archive =
                b.archiveCount > 1
                    ? `${b.ecosystem ?? 'archive'} (archive ${b.archiveIndex} of ${b.archiveCount})`
                    : 'advisories';
            const parts: string[] = [];
            let bar: FeedLine['bar'] = 'indeterminate';
            if (b.phase === 'downloading') {
                parts.push(`Downloading ${archive}`);
                if (b.contentLength) {
                    parts.push(`${formatBytes(b.bytesReceived)} of ${formatBytes(b.contentLength)}`);
                    bar = Math.min(1, b.bytesReceived / b.contentLength);
                } else if (b.bytesReceived > 0) {
                    parts.push(formatBytes(b.bytesReceived));
                }
            } else if (b.phase === 'importing') {
                parts.push(`Importing ${archive}`);
                if (b.archiveEntries) {
                    parts.push(`${num(b.recordsProcessed)} of ${num(b.archiveEntries)} records`);
                    bar = Math.min(1, b.recordsProcessed / b.archiveEntries);
                } else {
                    parts.push(`${num(b.recordsProcessed)} records`);
                }
                if (b.recordsFromEarlierArchives > 0) {
                    parts.push(`${num(b.recordsFromEarlierArchives + b.recordsProcessed)} in total`);
                }
            } else {
                parts.push('Publishing the mirror');
                parts.push(`${num(b.recordsFromEarlierArchives + b.recordsProcessed)} records imported`);
                bar = 1;
            }
            parts.push(`${elapsed(b.startedAt, now)} elapsed`);

            const sinceUpdate = now - new Date(b.updatedAt).getTime();
            if (sinceUpdate > PROGRESS_STALE_AFTER_MS) {
                parts.push(`no progress reported for ${formatDuration(sinceUpdate)}; check the server log`);
            }
            return { ...line, detail: parts.join(' · '), bar, steps: archiveSteps(b) };
        }
    }
}

/**
 * One step per archive of a scoped bootstrap, so the ecosystems already in
 * show as ticked rather than disappearing behind the one in flight. The
 * publishing tail has every archive in. The global `all.zip` is one step,
 * which the detail line already narrates, so it gets no list.
 */
function archiveSteps(b: BootstrapProgress): FeedStep[] | null {
    if (b.archives.length <= 1) return null;
    return b.archives.map((archive, i): FeedStep => {
        const label = archive.ecosystem ?? `Archive ${i + 1}`;
        if (b.phase === 'publishing' || i < b.archiveIndex - 1) {
            return {
                label,
                status: 'done',
                detail: archive.records != null ? `${num(archive.records)} records` : 'Done',
            };
        }
        if (i === b.archiveIndex - 1) {
            return { label, status: 'running', detail: b.phase === 'downloading' ? 'Downloading' : 'Importing' };
        }
        return { label, status: 'pending', detail: 'Waiting' };
    });
}

function feedLine(
    key: 'epss' | 'kev',
    feed: MirrorStatus['epss'] | MirrorStatus['kev'],
    osvReady: boolean,
    now: number,
    text: { name: string; role: string; verb: string; ready: string; without: string },
): FeedLine {
    const line = { key, name: text.name, role: text.role, status: feed.status, bar: null, steps: null };
    switch (feed.status) {
        case 'ready':
            return { ...line, detail: text.ready };
        case 'running':
            return {
                ...line,
                detail: feed.runStartedAt ? `${text.verb} · ${elapsed(feed.runStartedAt, now)} elapsed` : text.verb,
            };
        case 'failed':
            return {
                ...line,
                detail: `Failed: ${feed.lastError ?? 'unknown error'}. The server retries daily; ${text.without}.`,
            };
        case 'pending':
            return { ...line, detail: osvReady ? 'Starting shortly.' : 'Runs after the OSV import.' };
    }
}

export function mirrorBannerState(status: MirrorStatus | null, now: number = Date.now()): MirrorBannerState {
    // Unknown (the request failed, or the shell has not fetched yet) reads as
    // ready: a banner about the mirror must never appear because of a network
    // blip on the banner's own request.
    if (!status || status.ready) return { kind: 'ready' };

    const osvReady = status.osv.status === 'ready';
    const feeds: FeedLine[] = [
        osvLine(status.osv, now),
        feedLine('epss', status.epss, osvReady, now, {
            name: 'EPSS',
            role: 'Exploitation probability',
            verb: 'Scoring advisories',
            ready:
                status.epss.scoreDate && status.epss.cvesMatched != null
                    ? `Scores from ${status.epss.scoreDate} · ${num(status.epss.cvesMatched)} CVEs matched`
                    : 'Scored',
            without: 'until then findings rank on CVSS alone',
        }),
        feedLine('kev', status.kev, osvReady, now, {
            name: 'CISA KEV',
            role: 'Known exploited',
            verb: 'Marking exploited advisories',
            ready:
                status.kev.catalogVersion && status.kev.entriesMatched != null
                    ? `Catalogue ${status.kev.catalogVersion} · ${num(status.kev.entriesMatched)} entries matched`
                    : 'Applied',
            without: 'until then no finding is flagged as known-exploited',
        }),
    ];

    // Danger is for "nothing will change until the schedule retries": the OSV
    // import failed while the feeds that wait on it are, by construction,
    // still pending — so while it is outstanding the tone is its alone.
    if (!osvReady) {
        return status.osv.status === 'failed'
            ? {
                  kind: 'building',
                  tone: 'danger',
                  headline: 'Vulnerability database could not be built yet.',
                  summary: 'Images show no findings until it succeeds. The server retries on its schedule.',
                  feeds,
              }
            : {
                  kind: 'building',
                  tone: 'info',
                  headline: 'Vulnerability database is being built.',
                  summary: 'Images show no findings until the import finishes, usually 5–25 minutes.',
                  feeds,
              };
    }
    const stalled = feeds.every((f) => f.status === 'ready' || f.status === 'failed');
    return stalled
        ? {
              kind: 'building',
              tone: 'danger',
              headline: 'Exploitation data has not loaded.',
              summary: 'Radar Scores rank on CVSS alone until EPSS and KEV load. The server retries daily.',
              feeds,
          }
        : {
              kind: 'building',
              tone: 'info',
              headline: 'Vulnerability database is almost ready.',
              summary: 'Radar Scores settle once EPSS and KEV have loaded.',
              feeds,
          };
}

/**
 * Whether the shell should keep polling: only while the state is expected
 * to change on its own (`usePollWhile`'s rule). A database with every feed
 * landed is the end state and polls nothing.
 */
export function mirrorNeedsPolling(status: MirrorStatus | null): boolean {
    return status !== null && !status.ready;
}
