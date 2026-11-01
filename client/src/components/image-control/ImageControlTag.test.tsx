import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageControlTag } from './ImageControlTag';

/**
 * Whose image a row is, as a tag. "Unconfirmed" is the one label a reader
 * cannot unpack, so it alone carries a visible cue that a definition is
 * there; every tag has its definition in a tooltip rather than a native
 * `title`, which rendered unreliably.
 */
describe('ImageControlTag', () => {
    it('cues the Unconfirmed tag with an info icon and defines it in a tooltip', () => {
        const html = renderToStaticMarkup(
            <ImageControlTag control="unknown" detectedBy={null} detail={null} repository="docker.io/nginx" />,
        );
        expect(html).toContain('Unconfirmed');
        expect(html).toMatch(/Unconfirmed<\/span><svg[^>]*aria-hidden="true"/);
        expect(html).toMatch(/role="tooltip"[^>]*>Unconfirmed — could not tell</);
        expect(html).not.toContain('title=');
    });

    it('defines the other tags on hover without a cue', () => {
        const html = renderToStaticMarkup(
            <ImageControlTag
                control="third-party"
                detectedBy="official-image"
                detail={null}
                repository="docker.io/nginx"
            />,
        );
        expect(html).toMatch(/role="tooltip"[^>]*>Third-party — Docker Official Image</);
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('decoration-dotted');
    });

    it('keeps the definition on the menu button when the reader may change the answer', () => {
        const html = renderToStaticMarkup(
            <ImageControlTag
                control="unknown"
                detectedBy={null}
                detail={null}
                repository="docker.io/nginx"
                onChange={() => {}}
            />,
        );
        expect(html).toMatch(/<button[^>]*aria-label="Unconfirmed image: change who builds docker\.io\/nginx"/);
        expect(html).toMatch(/role="tooltip"[^>]*>Unconfirmed — could not tell</);
        // The button is the tab stop; the trigger inside it is not another one.
        expect(html).not.toContain('tabindex="0"');
        expect(html).not.toContain('title=');
    });
});
