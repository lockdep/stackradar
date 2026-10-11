import { describe, expect, it } from 'vitest';
import { mirrorBannerState, mirrorNeedsPolling, type MirrorStatus } from './mirror-status';

const base: MirrorStatus = {
    initialized: false,
    syncStatus: 'idle',
    initCompletedAt: null,
    lastSuccessfulPollAt: null,
    lastError: null,
    ecosystems: null,
};

describe('mirrorBannerState', () => {
    it('is silent while the status is unknown', () => {
        expect(mirrorBannerState(null)).toEqual({ kind: 'ready' });
    });

    it('is silent once the mirror has a live generation, whatever is running now', () => {
        expect(mirrorBannerState({ ...base, initialized: true })).toEqual({ kind: 'ready' });
        expect(mirrorBannerState({ ...base, initialized: true, syncStatus: 'full_refresh' })).toEqual({
            kind: 'ready',
        });
        expect(mirrorBannerState({ ...base, initialized: true, syncStatus: 'incremental' })).toEqual({ kind: 'ready' });
    });

    it('reports a running first bootstrap as building', () => {
        expect(mirrorBannerState({ ...base, syncStatus: 'full_refresh' })).toEqual({ kind: 'building' });
    });

    it('reports an uninitialised, idle mirror as waiting, carrying the last error', () => {
        expect(mirrorBannerState(base)).toEqual({ kind: 'waiting', lastError: null });
        expect(mirrorBannerState({ ...base, lastError: 'download stalled' })).toEqual({
            kind: 'waiting',
            lastError: 'download stalled',
        });
    });
});

describe('mirrorNeedsPolling', () => {
    it('polls only an uninitialised mirror', () => {
        expect(mirrorNeedsPolling(null)).toBe(false);
        expect(mirrorNeedsPolling(base)).toBe(true);
        expect(mirrorNeedsPolling({ ...base, syncStatus: 'full_refresh' })).toBe(true);
        expect(mirrorNeedsPolling({ ...base, initialized: true })).toBe(false);
    });
});
