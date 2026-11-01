import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCOPE_CHIP_TITLE, ScopeChip, scopeChipLabel } from './ScopeChip';

/**
 * The chip the exposure strip and the Clusters section both wear: the same
 * words as the filter bar's menus, so a reader comparing the two blocks'
 * numbers sees that they are counted under the same two filters.
 */
describe('scopeChipLabel', () => {
    it('names the lens and the image scope in the filter bar’s words', () => {
        expect(scopeChipLabel('application', 'all')).toBe('Application findings · all images');
        expect(scopeChipLabel('base', 'yours')).toBe('Base image findings · organization images');
        expect(scopeChipLabel('all', 'third-party')).toBe('All findings · third-party images');
    });

    it('says only "All findings" when neither filter narrows anything', () => {
        expect(scopeChipLabel('all', 'all')).toBe('All findings');
    });

    it('adds where the counts are from when a cluster or namespace is chosen, after the two filters', () => {
        expect(scopeChipLabel('all', 'all', 'platform-eu1')).toBe('All findings · in platform-eu1');
        expect(scopeChipLabel('application', 'yours', 'platform-eu1 / argocd')).toBe(
            'Application findings · organization images · in platform-eu1 / argocd',
        );
        expect(scopeChipLabel('base', 'all', 'namespace argocd')).toBe(
            'Base image findings · all images · in namespace argocd',
        );
        expect(scopeChipLabel('all', 'all', null)).toBe('All findings');
    });

    it('never says tier, os, runtime or control', () => {
        for (const lens of ['application', 'base', 'all'] as const) {
            for (const control of ['yours', 'third-party', 'all'] as const) {
                expect(scopeChipLabel(lens, control)).not.toMatch(/\btier\b|\bos\b|\bruntime\b|\bcontrol\b/i);
            }
        }
    });
});

describe('ScopeChip', () => {
    it('renders the label with the title a test or a hover finds it by', () => {
        const html = renderToStaticMarkup(<ScopeChip lens="application" control="all" />);
        expect(html).toContain(`title="${SCOPE_CHIP_TITLE}"`);
        expect(html).toContain('Application findings · all images');
    });

    it('names the scope when the page is narrowed to a cluster or namespace', () => {
        const html = renderToStaticMarkup(<ScopeChip lens="all" control="all" where="platform-eu1 / argocd" />);
        expect(html).toContain('All findings · in platform-eu1 / argocd');
    });
});
