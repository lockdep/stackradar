import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RISK_SCORE_DOCS_LABEL, RISK_SCORE_DOCS_URL, RISK_SCORE_SUBTITLE, TOTAL_RISK_HINT } from '@/lib/risk';
import { MetricsChartCard } from './MetricsChartCard';

/**
 * The trend cards' subtitles. The Risk Score's is the one that names a unit
 * nobody can guess, so that card alone carries the score's definition behind
 * an ⓘ; a count card has nothing to define. The subtitle itself stays one
 * line, like its neighbours', and nothing is drawn under the card: a line
 * below one card of a row misaligns the row.
 */
describe('MetricsChartCard description', () => {
    const riskCard = () =>
        renderToStaticMarkup(
            <MetricsChartCard
                title="Risk Score"
                description={RISK_SCORE_SUBTITLE}
                dataKey="riskScore"
                data={[]}
                href="/risk-score"
                hrefTitle="See what drives the score"
            />,
        );

    it('defines the Risk Score behind a cued tooltip, keeping the one-line subtitle as written', () => {
        const html = riskCard();
        expect(html).toContain('Sum of every finding’s 0–100 contribution — not out of 100');
        expect(html).toMatch(/role="tooltip"[^>]*>Risk Score: the sum of every finding’s 0–100 contribution/);
        expect(html).toMatch(/not out of 100<svg[^>]*lucide-info[^>]*aria-hidden="true"/);
        // Inside the card's link, so the trigger is not a second tab stop.
        expect(html).not.toContain('tabindex="0"');
    });

    it('is one anchor — the card — with the docs link left to the breakdown page it opens', () => {
        const html = riskCard();
        expect(html.match(/<a /g)).toHaveLength(1);
        expect(html).not.toContain(RISK_SCORE_DOCS_LABEL);
        expect(html).not.toContain(RISK_SCORE_DOCS_URL);
        expect(html).toMatch(/<a [^>]*class="[^"]*\bh-full\b[^"]*"[^>]*href="\/risk-score"/);
    });

    it('leaves a count card’s subtitle alone', () => {
        const html = renderToStaticMarkup(
            <MetricsChartCard
                title="Packages"
                description="Unique packages from all current SBOMs"
                dataKey="totalComponents"
                data={[]}
            />,
        );
        expect(html).toContain('Unique packages from all current SBOMs');
        expect(html).not.toContain('role="tooltip"');
    });
});

/**
 * The subtitle, the tooltip and the docs link say the same thing about the
 * same number, and the surfaces that draw them read from one constant each.
 * A view that pastes its own sentence is the drift this guards against.
 */
describe('Risk Score definition', () => {
    it('subtitle names the unit and the bound; the hint carries the formula', () => {
        expect(RISK_SCORE_SUBTITLE).toMatch(/0–100/);
        expect(RISK_SCORE_SUBTITLE).toMatch(/not out of 100/i);
        expect(RISK_SCORE_SUBTITLE.length).toBeLessThan(70);
        for (const term of [/0–100/, /CVSS/, /EPSS/, /KEV/, /running images/, /not out of 100/i, /Unbounded/]) {
            expect(TOTAL_RISK_HINT).toMatch(term);
        }
    });

    it('is read from the shared constant by both the Dashboard and the cluster Overview', () => {
        for (const file of ['src/views/DashboardView.tsx', 'src/components/clusters/ClusterOverviewTab.tsx']) {
            const source = readFileSync(resolve(process.cwd(), file), 'utf8');
            expect(source, file).toMatch(/import \{[^}]*\bRISK_SCORE_SUBTITLE\b[^}]*\} from '@\/lib\/risk'/);
            expect(source, file).toContain('description={RISK_SCORE_SUBTITLE}');
            expect(source, file).not.toMatch(/Sum of every finding/);
        }
    });

    it('links the docs write-up from the breakdown page, by the shared label and URL', () => {
        const source = readFileSync(resolve(process.cwd(), 'src/components/clusters/RiskScoreBreakdown.tsx'), 'utf8');
        expect(source).toMatch(/import \{[^}]*\bRISK_SCORE_DOCS_URL\b[^}]*\} from '@\/lib\/risk'/);
        expect(source).toContain('href={RISK_SCORE_DOCS_URL}');
        expect(source).toContain('{RISK_SCORE_DOCS_LABEL}');
        expect(RISK_SCORE_DOCS_URL).toBe('https://stackradar.io/docs/risk-score');
    });
});
