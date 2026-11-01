import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KEV_HINT } from '@/lib/risk';
import { KevBadge, RiskCell } from './RiskScore';

/**
 * The KEV mark: the word, in the severity badge's geometry, defined on hover.
 * No icon and no pill — a shield in a rounded pill read as a different kind
 * of object from the square severity badge it sits beside.
 */
describe('KevBadge', () => {
    it('is a square outlined word with no icon', () => {
        const html = renderToStaticMarkup(<KevBadge />);
        expect(html).toMatch(
            /<span class="[^"]*\bpx-1 py-px text-xs font-medium uppercase tracking-wide\b[^"]*">KEV<\/span>/,
        );
        expect(html).not.toContain('rounded-full');
        expect(html).not.toContain('<svg');
    });

    it('explains what KEV is, as the badge’s accessible description', () => {
        const html = renderToStaticMarkup(<KevBadge />);
        expect(html).toMatch(/aria-describedby="([^"]+)"/);
        const id = html.match(/aria-describedby="([^"]+)"/)![1];
        expect(html).toContain(`role="tooltip" id="${id}"`);
        expect(html).toContain('Known Exploited Vulnerabilities');
        expect(html).toContain(KEV_HINT);
        // Not a tab stop of its own: the badge sits inside rows and options.
        expect(html).not.toContain('tabindex="0"');
    });

    it('appends the due date and ransomware facts after the definition', () => {
        const html = renderToStaticMarkup(<KevBadge dueDate="2026-03-01T00:00:00Z" ransomware="Known" />);
        expect(html).toMatch(
            /Known Exploited Vulnerabilities.*CISA remediation due 2026-03-01\. Used in known ransomware campaigns\./,
        );
    });

    it('carries a count when there are several, and nothing when there are none', () => {
        expect(renderToStaticMarkup(<KevBadge count={3} />)).toContain('KEV ×3');
        expect(renderToStaticMarkup(<KevBadge count={1} />)).toMatch(/>KEV<\/span>/);
        expect(renderToStaticMarkup(<KevBadge count={0} />)).toBe('');
    });
});

describe('RiskCell KEV mark', () => {
    it('leads the total with the word, not a shield', () => {
        const html = renderToStaticMarkup(
            <RiskCell
                risk={{
                    score: 1234,
                    band: 'critical',
                    findingCount: 4,
                    kevCount: 2,
                    exploitedCount: 2,
                    topFinding: null,
                }}
            />,
        );
        expect(html).not.toContain('<svg');
        expect(html).toMatch(/text-danger">KEV<span class="sr-only"> 2 on CISA KEV<\/span>/);
        expect(html).toContain('2 confirmed exploited in the wild');
        expect(html).toContain('1,234');
    });
});
