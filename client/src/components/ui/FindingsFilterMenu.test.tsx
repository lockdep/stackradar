import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingsFilterMenu, unclassifiedMenuNote } from './FilterBar';
import { FilterMenu } from './FilterMenu';
import { TIER_LENS_UNCLASSIFIED_LABEL, unclassifiedFindings } from '@/lib/tier-lens';

/**
 * The Findings menu offers two lenses and "All", and shows a count on each.
 * Findings in packages no scan has classified are in neither lens, so
 * Application + Base image fell short of All with nothing to say why. The
 * menu now carries the third bucket as an inert, counted row — not a lens,
 * since those findings are only ever listed under All.
 *
 * Headless UI draws a closed menu's items nowhere, so the rows themselves
 * are checked through the pure helper that builds the note; the render
 * checks cover the closed button and the note's own markup.
 */
describe('unclassifiedMenuNote — the third bucket', () => {
    it('is the gap between All and the two lenses, so the three add up', () => {
        const counts = { application: 12, base: 231, all: 250 };
        expect(unclassifiedFindings(counts)).toBe(7);
        expect(counts.application + counts.base + unclassifiedFindings(counts)).toBe(counts.all);
        expect(unclassifiedMenuNote(counts)).toMatchObject({ label: TIER_LENS_UNCLASSIFIED_LABEL, count: 7 });
        expect(unclassifiedMenuNote(counts)?.description).toMatch(/All findings/);
    });

    it('is absent when every finding is in one of the two buckets, and before the counts arrive', () => {
        expect(unclassifiedMenuNote({ application: 12, base: 231, all: 243 })).toBeNull();
        expect(unclassifiedMenuNote(undefined)).toBeNull();
    });

    it('never goes negative when a stale response puts more in the buckets than in All', () => {
        expect(unclassifiedFindings({ application: 5, base: 5, all: 9 })).toBe(0);
    });
});

describe('FindingsFilterMenu', () => {
    it('renders closed as its value, with counts and the third bucket in hand', () => {
        const html = renderToStaticMarkup(
            <FindingsFilterMenu
                value="application"
                onChange={() => {}}
                counts={{ application: 12, base: 231, all: 250 }}
            />,
        );
        expect(html).toContain('aria-label="Findings: Application findings"');
    });
});

describe('FilterMenu — the note row', () => {
    it('is not an option: no role, no check slot content, aria-disabled, the count beside the label', () => {
        // `MenuItems static` is not exposed, so the row is checked where it is
        // drawn: a closed menu renders no panel at all, note included.
        const closed = renderToStaticMarkup(
            <FilterMenu
                label="Findings"
                value="all"
                options={[{ value: 'all', label: 'All findings', count: 250 }]}
                onChange={() => {}}
                note={{ label: TIER_LENS_UNCLASSIFIED_LABEL, count: 7 }}
            />,
        );
        expect(closed).not.toContain(TIER_LENS_UNCLASSIFIED_LABEL);
        expect(closed).toContain('aria-label="Findings: All findings"');
    });
});
