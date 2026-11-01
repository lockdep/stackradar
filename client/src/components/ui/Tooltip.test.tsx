import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tooltip } from './Tooltip';

/**
 * A definition one hover away, with a visible sign that it is there. The
 * bubble is always in the markup as the trigger's accessible description —
 * what a native `title` never reliably gave — and is drawn on hover and
 * keyboard focus.
 */
describe('Tooltip', () => {
    it('renders the definition in a tooltip the trigger is described by', () => {
        const html = renderToStaticMarkup(<Tooltip text="Pods observed running this image">Pods</Tooltip>);
        const trigger = html.match(/aria-describedby="([^"]+)"/);
        expect(trigger).not.toBeNull();
        const bubble = html.match(/<span role="tooltip" id="([^"]+)"[^>]*>Pods observed running this image<\/span>/);
        expect(bubble).not.toBeNull();
        expect(bubble![1]).toBe(trigger![1]);
    });

    it('marks the trigger with a dotted underline by default, and is its own tab stop', () => {
        const html = renderToStaticMarkup(<Tooltip text="A definition">Age</Tooltip>);
        expect(html).toMatch(/<span tabindex="0"[^>]*decoration-dotted[^>]*>Age/);
        expect(html).not.toContain('title=');
    });

    it('can mark the trigger with an info icon instead', () => {
        const html = renderToStaticMarkup(
            <Tooltip text="A definition" cue="icon">
                Unconfirmed
            </Tooltip>,
        );
        expect(html).not.toContain('decoration-dotted');
        expect(html).toMatch(/Unconfirmed<svg[^>]*aria-hidden="true"/);
    });

    it('is not a tab stop inside a control, where the control’s focus opens it', () => {
        const html = renderToStaticMarkup(
            <Tooltip text="A definition" focusable={false}>
                Age
            </Tooltip>,
        );
        expect(html).not.toContain('tabindex=');
        // `&` is HTML-escaped in markup; the class is `[button:focus-visible_&]:visible`.
        expect(html).toContain('[button:focus-visible_&amp;]:visible');
        expect(html).toContain('[a:focus-visible_&amp;]:visible');
    });

    it('is hidden until engaged, never removed', () => {
        const html = renderToStaticMarkup(<Tooltip text="A definition">Age</Tooltip>);
        expect(html).toMatch(/role="tooltip"[^>]*invisible opacity-0/);
        expect(html).not.toMatch(/role="tooltip"[^>]*\bhidden\b/);
    });
});
