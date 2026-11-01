import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGE_COLUMN_HINT, AgeColumnLabel } from './AgeColumnLabel';

/**
 * "Age" on the containers list is time on this digest, which nothing in the
 * word says: the header carries the definition, visibly cued, and no native
 * `title` — which rendered unreliably and gave no sign it was there.
 */
describe('AgeColumnLabel', () => {
    it('shows "Age" with a dotted underline and its definition in a tooltip', () => {
        const html = renderToStaticMarkup(<AgeColumnLabel />);
        expect(html).toMatch(/decoration-dotted[^>]*>Age</);
        expect(html).toContain(`role="tooltip"`);
        expect(html).toContain(AGE_COLUMN_HINT);
        expect(html).toContain('How long the container has run this exact image');
        expect(html).not.toContain('title=');
    });

    it('is not its own tab stop: the sortable header’s button is', () => {
        const html = renderToStaticMarkup(<AgeColumnLabel />);
        expect(html).not.toContain('tabindex=');
    });
});
