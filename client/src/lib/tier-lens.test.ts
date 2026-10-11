import { describe, expect, it } from 'vitest';
import { apiTierParam, lensHref, resolveLens, withTierParam } from './tier-lens';

describe('resolveLens', () => {
    it('opens on Application when nothing says otherwise', () => {
        expect(resolveLens(null, null)).toBe('application');
    });

    it('prefers the URL, then the stored choice, then the page fallback', () => {
        expect(resolveLens('base', 'all', 'application')).toBe('base');
        expect(resolveLens(null, 'all', 'application')).toBe('all');
        expect(resolveLens(null, null, 'all')).toBe('all');
    });

    it('degrades a hand-edited value to the next source rather than throwing', () => {
        expect(resolveLens('os,runtime', 'base')).toBe('base');
        expect(resolveLens('banana', 'banana')).toBe('application');
    });
});

describe('lensHref — the URL round-trip', () => {
    it('writes the lens beside the filters already in the URL, and reads back', () => {
        const href = lensHref('/vulnerabilities', 'severity=critical&search=openssl', 'base');
        const params = new URL(href, 'https://x').searchParams;
        expect(params.get('severity')).toBe('critical');
        expect(params.get('search')).toBe('openssl');
        expect(resolveLens(params.get('tier'), null)).toBe('base');
    });

    it('writes the default too — it is per reader, so a link must carry it', () => {
        expect(lensHref('/images/1', '', 'application')).toBe('/images/1?tier=application');
    });

    it('replaces rather than repeats an existing lens', () => {
        expect(lensHref('/', 'tier=all', 'application')).toBe('/?tier=application');
    });
});

describe('the API parameter', () => {
    it('sends tier values, never the lens name, and nothing for All', () => {
        expect(apiTierParam('application')).toBe('application,main');
        expect(apiTierParam('base')).toBe('os,runtime');
        expect(apiTierParam('all')).toBeNull();
        expect(withTierParam(new URLSearchParams({ limit: '50' }), 'all').toString()).toBe('limit=50');
        expect(withTierParam(new URLSearchParams(), 'application').get('tier')).toBe('application,main');
    });
});
