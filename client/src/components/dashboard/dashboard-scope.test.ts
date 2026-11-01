import { describe, expect, it } from 'vitest';
import { WHOLE_ORGANIZATION, isScoped, readScope, scopeWords, withinParams, writeScope } from './dashboard-scope';
import { mostCriticalUrl } from './MostCritical';

/**
 * The Dashboard's cluster / namespace scope: read from the URL as `/containers`
 * writes it, written back without defaults, and put on every request that
 * takes it — so a pasted link and the numbers on it agree.
 */
describe('dashboard scope ↔ URL', () => {
    it('reads `?cluster=` and `?namespace=`, and an absent or empty parameter as all', () => {
        expect(readScope(new URLSearchParams('cluster=c-1&namespace=argocd'))).toEqual({
            clusterId: 'c-1',
            namespace: 'argocd',
        });
        expect(readScope(new URLSearchParams('namespace='))).toEqual(WHOLE_ORGANIZATION);
        expect(readScope(new URLSearchParams())).toEqual(WHOLE_ORGANIZATION);
    });

    it('writes the scope onto the page query and deletes what is "all", leaving other parameters alone', () => {
        const scoped = writeScope(new URLSearchParams('tab=x'), { clusterId: 'c-1', namespace: 'argocd' });
        expect(scoped.toString()).toBe('tab=x&cluster=c-1&namespace=argocd');
        const cleared = writeScope(new URLSearchParams('tab=x&cluster=c-1&namespace=argocd'), WHOLE_ORGANIZATION);
        expect(cleared.toString()).toBe('tab=x');
    });

    it('knows when nothing is narrowed', () => {
        expect(isScoped(WHOLE_ORGANIZATION)).toBe(false);
        expect(isScoped({ clusterId: null, namespace: 'argocd' })).toBe(true);
    });
});

describe('dashboard scope → requests', () => {
    it('puts the same two parameters on a request, and none when there is no scope', () => {
        expect(withinParams(new URLSearchParams('limit=3'), { clusterId: 'c-1', namespace: null }).toString()).toBe(
            'limit=3&cluster=c-1',
        );
        expect(withinParams(new URLSearchParams('limit=3'), WHOLE_ORGANIZATION).toString()).toBe('limit=3');
        expect(withinParams(new URLSearchParams('limit=3'), undefined).toString()).toBe('limit=3');
    });

    it('scopes the Most critical query, after the lens and image filters', () => {
        expect(
            mostCriticalUrl({
                lens: 'application',
                control: 'yours',
                within: { clusterId: 'c-1', namespace: 'argocd' },
            }),
        ).toBe(
            '/api/vulnerabilities?limit=3&offset=0&control=yours&cluster=c-1&namespace=argocd&tier=application%2Cmain',
        );
        expect(mostCriticalUrl({ lens: 'all', control: 'all' })).toBe('/api/vulnerabilities?limit=3&offset=0');
    });
});

describe('scopeWords', () => {
    it('names cluster, namespace or both, and nothing when there is no scope', () => {
        expect(scopeWords(WHOLE_ORGANIZATION, null)).toBeNull();
        expect(scopeWords({ clusterId: 'c-1', namespace: null }, 'platform-eu1')).toBe('platform-eu1');
        expect(scopeWords({ clusterId: null, namespace: 'argocd' }, null)).toBe('namespace argocd');
        expect(scopeWords({ clusterId: 'c-1', namespace: 'argocd' }, 'platform-eu1')).toBe('platform-eu1 / argocd');
    });

    it('says a stale cluster id is a scope in force rather than hiding it', () => {
        expect(scopeWords({ clusterId: 'gone', namespace: null }, null)).toBe('an unknown cluster');
    });
});
