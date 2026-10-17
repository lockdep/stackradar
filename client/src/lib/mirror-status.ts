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
    /** 0–1 when the current step's size is known; null draws no bar. */
    fraction: number | null;
}

export type MirrorBannerState =
    /** Every feed has landed. Nothing to say. */
    | { kind: 'ready' }
    | {
          kind: 'building';
          /** `danger` when nothing is running and something has failed; `attention` while work is in progress. */
          tone: 'attention' | 'danger';
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
    const line = { key: 'osv' as const, name: 'OSV.dev', role: 'Advisory mirror', status: osv.status };
    switch (osv.status) {
        case 'ready':
            return {
                ...line,
                detail: osv.ecosystems ? `Mirrored: ${osv.ecosystems.join(', ')}` : 'Mirrored: every ecosystem',
                fraction: null,
            };
        case 'failed':
            return {
                ...line,
                detail: `The first import failed: ${osv.lastError ?? 'unknown error'}. The server retries on its schedule.`,
                fraction: null,
            };
        case 'pending':
            return {
                ...line,
                detail: 'Not started yet. The server begins the first import as soon as it is up.',
                fraction: null,
            };
        case 'running': {
            const b = osv.bootstrap;
            if (!b) return { ...line, detail: 'Import running. Progress has not been reported yet.', fraction: null };

            const archive =
                b.archiveCount > 1
                    ? `${b.ecosystem ?? 'archive'} (archive ${b.archiveIndex} of ${b.archiveCount})`
                    : 'advisories';
            const parts: string[] = [];
            let fraction: number | null = null;
            if (b.phase === 'downloading') {
                parts.push(`Downloading ${archive}`);
                if (b.contentLength) {
                    parts.push(`${formatBytes(b.bytesReceived)} of ${formatBytes(b.contentLength)}`);
                    fraction = Math.min(1, b.bytesReceived / b.contentLength);
                } else if (b.bytesReceived > 0) {
                    parts.push(formatBytes(b.bytesReceived));
                }
            } else if (b.phase === 'importing') {
                parts.push(`Importing ${archive}`);
                if (b.archiveEntries) {
                    parts.push(`${num(b.recordsProcessed)} of ${num(b.archiveEntries)} records`);
                    fraction = Math.min(1, b.recordsProcessed / b.archiveEntries);
                } else {
                    parts.push(`${num(b.recordsProcessed)} records`);
                }
                if (b.recordsFromEarlierArchives > 0) {
                    parts.push(`${num(b.recordsFromEarlierArchives + b.recordsProcessed)} in total`);
                }
            } else {
                parts.push('Publishing the mirror');
                parts.push(`${num(b.recordsFromEarlierArchives + b.recordsProcessed)} records imported`);
                fraction = 1;
            }
            parts.push(`${elapsed(b.startedAt, now)} elapsed`);

            const sinceUpdate = now - new Date(b.updatedAt).getTime();
            if (sinceUpdate > PROGRESS_STALE_AFTER_MS) {
                parts.push(`no progress reported for ${formatDuration(sinceUpdate)}; check the server log`);
            }
            return { ...line, detail: parts.join(' · '), fraction };
        }
    }
}

function feedLine(
    key: 'epss' | 'kev',
    feed: MirrorStatus['epss'] | MirrorStatus['kev'],
    osvReady: boolean,
    now: number,
    text: { name: string; role: string; verb: string; ready: string; without: string },
): FeedLine {
    const line = { key, name: text.name, role: text.role, status: feed.status, fraction: null };
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
                  summary:
                      'The first OSV import has not completed, so images show no findings. The server retries on its schedule; the error is below.',
                  feeds,
              }
            : {
                  kind: 'building',
                  tone: 'attention',
                  headline: 'Vulnerability database is being built.',
                  summary:
                      'Images show no findings until the OSV import finishes — allow 5–25 minutes depending on your connection. This page updates on its own.',
                  feeds,
              };
    }
    const stalled = feeds.every((f) => f.status === 'ready' || f.status === 'failed');
    return stalled
        ? {
              kind: 'building',
              tone: 'danger',
              headline: 'Exploitation data has not loaded.',
              summary:
                  'Findings are in, but Radar Scores rank on CVSS alone until EPSS and KEV complete. The server retries daily; the errors are below.',
              feeds,
          }
        : {
              kind: 'building',
              tone: 'attention',
              headline: 'Vulnerability database is almost ready.',
              summary:
                  'Findings are in. Exploitation data is still loading, so Radar Scores will settle in the next few minutes. This page updates on its own.',
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
