import { describe, it, expect } from 'vitest';
import {
    DEFAULT_SEVERITY_FILTER,
    EXPLOITED_EPSS_THRESHOLD,
    SEVERITY_BANDS,
    filterBySeverity,
    hasExploitEvidence,
    isUnscored,
    severityBucket,
} from './severity';

type V = { id: string; severityLevel: string | null; kevListedAt?: string | null; epssScore?: number | null };
const v = (id: string, severityLevel: string | null, extra: Partial<V> = {}): V => ({ id, severityLevel, ...extra });

describe('severityBucket', () => {
    it('maps the four bands case-insensitively', () => {
        expect(severityBucket('CRITICAL')).toBe('critical');
        expect(severityBucket('High')).toBe('high');
        expect(severityBucket('medium')).toBe('medium');
        expect(severityBucket('low')).toBe('low');
    });

    it("treats the mirror's 'unknown', null, undefined and stray labels as unscored", () => {
        expect(severityBucket('unknown')).toBe('unscored');
        expect(severityBucket(null)).toBe('unscored');
        expect(severityBucket(undefined)).toBe('unscored');
        expect(severityBucket('INFO')).toBe('unscored');
        expect(isUnscored('unknown')).toBe(true);
        expect(isUnscored('low')).toBe(false);
    });
});

describe('hasExploitEvidence', () => {
    it('is true for any KEV listing', () => {
        expect(hasExploitEvidence({ kevListedAt: '2024-01-01', epssScore: null })).toBe(true);
    });

    it('is true at or above the EPSS threshold and false below it', () => {
        expect(hasExploitEvidence({ epssScore: EXPLOITED_EPSS_THRESHOLD })).toBe(true);
        expect(hasExploitEvidence({ epssScore: EXPLOITED_EPSS_THRESHOLD - 0.001 })).toBe(false);
        expect(hasExploitEvidence({ epssScore: null })).toBe(false);
        expect(hasExploitEvidence({})).toBe(false);
    });
});

describe('filterBySeverity', () => {
    const rows = [
        v('crit', 'critical'),
        v('unk-1', 'unknown'),
        v('high', 'high'),
        v('unk-kev', 'unknown', { kevListedAt: '2024-01-01' }),
        v('med', 'medium'),
        v('unk-epss', null, { epssScore: 0.4 }),
        v('low', 'low'),
        v('unk-2', 'unknown', { epssScore: 0.01 }),
    ];

    it('hides unscored findings by default but keeps exploited ones, moved last', () => {
        const { shown, hiddenUnscored } = filterBySeverity(rows, DEFAULT_SEVERITY_FILTER);
        expect(shown.map((r) => r.id)).toEqual(['crit', 'high', 'med', 'low', 'unk-kev', 'unk-epss']);
        expect(hiddenUnscored).toBe(2);
    });

    it('shows every unscored finding when included, still after the scored ones', () => {
        const { shown, hiddenUnscored } = filterBySeverity(rows, { ...DEFAULT_SEVERITY_FILTER, includeUnscored: true });
        expect(shown.map((r) => r.id)).toEqual(['crit', 'high', 'med', 'low', 'unk-1', 'unk-kev', 'unk-epss', 'unk-2']);
        expect(hiddenUnscored).toBe(0);
    });

    it('drops deselected bands without touching the unscored rule', () => {
        const { shown, hiddenUnscored } = filterBySeverity(rows, {
            bands: new Set(['critical', 'high']),
            includeUnscored: false,
        });
        expect(shown.map((r) => r.id)).toEqual(['crit', 'high', 'unk-kev', 'unk-epss']);
        expect(hiddenUnscored).toBe(2);
    });

    it('returns nothing when no band is selected and unscored is off, except exploited unscored', () => {
        const { shown } = filterBySeverity(rows, { bands: new Set(), includeUnscored: false });
        expect(shown.map((r) => r.id)).toEqual(['unk-kev', 'unk-epss']);
    });

    it('preserves the incoming order of scored rows', () => {
        const shuffled = [v('b', 'low'), v('a', 'critical'), v('c', 'medium')];
        expect(filterBySeverity(shuffled, DEFAULT_SEVERITY_FILTER).shown.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    });

    it('defaults to every band on and unscored off', () => {
        expect([...DEFAULT_SEVERITY_FILTER.bands].sort()).toEqual([...SEVERITY_BANDS].sort());
        expect(DEFAULT_SEVERITY_FILTER.includeUnscored).toBe(false);
    });
});
