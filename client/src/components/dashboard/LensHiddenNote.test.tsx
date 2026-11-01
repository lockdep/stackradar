import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LensHiddenNote } from './LensHiddenNote';

/**
 * The sentence under the exposure strip saying what the lens hides, in the
 * unit the Critical card counts. Its counts are the critical findings per
 * bucket from the same response the cards read.
 */
describe('LensHiddenNote', () => {
    it('says how many criticals the Application lens hides, where they are, and offers Show all', () => {
        const html = renderToStaticMarkup(
            <LensHiddenNote
                lens="application"
                counts={{ application: 262, base: 90, all: 359 }}
                onShowAll={() => {}}
            />,
        );
        expect(html).toContain('Showing application findings');
        expect(html).toContain('97 critical in base images and ');
        expect(html).toMatch(/unclassified packages<\/span>.*? hidden/);
        expect(html).toMatch(/<button[^>]*>Show all<\/button>/);
    });

    it('defines "unclassified packages" where it says it, with a visible cue', () => {
        const html = renderToStaticMarkup(
            <LensHiddenNote
                lens="application"
                counts={{ application: 262, base: 90, all: 359 }}
                onShowAll={() => {}}
            />,
        );
        expect(html).toMatch(/decoration-dotted[^>]*>unclassified packages</);
        expect(html).toMatch(
            /role="tooltip"[^>]*>Packages StackRadar has not yet sorted into application or base image; they are counted under All\./,
        );
    });

    it('names only the other bucket when every hidden finding is classified', () => {
        const html = renderToStaticMarkup(
            <LensHiddenNote lens="base" counts={{ application: 12, base: 5, all: 17 }} onShowAll={() => {}} />,
        );
        expect(html).toContain('Showing base image findings');
        expect(html).toContain('12 critical in application packages hidden');
        expect(html).not.toContain('unclassified');
    });

    it('names only unclassified packages when the other bucket is empty', () => {
        const html = renderToStaticMarkup(
            <LensHiddenNote lens="application" counts={{ application: 4, base: 0, all: 7 }} onShowAll={() => {}} />,
        );
        expect(html).toContain('3 critical in ');
        expect(html).toMatch(/unclassified packages<\/span>.*? hidden/);
        expect(html).not.toContain('base images');
    });

    it('is silent under All findings, before the counts arrive, and when nothing is hidden', () => {
        expect(
            renderToStaticMarkup(
                <LensHiddenNote lens="all" counts={{ application: 1, base: 1, all: 2 }} onShowAll={() => {}} />,
            ),
        ).toBe('');
        expect(
            renderToStaticMarkup(<LensHiddenNote lens="application" counts={undefined} onShowAll={() => {}} />),
        ).toBe('');
        expect(
            renderToStaticMarkup(
                <LensHiddenNote lens="application" counts={{ application: 5, base: 0, all: 5 }} onShowAll={() => {}} />,
            ),
        ).toBe('');
    });
});
