import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MostCritical } from './MostCritical';
import { EMPTY_FIX_INDEX } from './fix-hints';
import type { ClusterVulnerabilitiesResponse } from '@/types/cluster';

type Row = ClusterVulnerabilitiesResponse['vulnerabilities'][number];

/** One row of the block, with the fields the row renders set to quiet defaults. */
function row(overrides: Partial<Row> & Pick<Row, 'identity' | 'vulnId'>): Row {
    return {
        exploited: false,
        severity: 'critical',
        riskScore: 77,
        cvssScore: 9.8,
        epssScore: 0.02,
        kevListedAt: null,
        kevDueDate: null,
        kevRansomware: null,
        packages: [{ name: 'lodash', version: '4.17.21', fixedVersion: '4.17.22', purlType: 'npm' }],
        fixAvailable: true,
        findingCount: 1,
        imageCount: 1,
        workloadCount: 1,
        containerCount: 1,
        clusterCount: 1,
        ...overrides,
    };
}

function response(vulnerabilities: Row[]): ClusterVulnerabilitiesResponse {
    return {
        vulnerabilities,
        total: vulnerabilities.length,
        totalFindings: vulnerabilities.length,
        unscoredFindings: 0,
        tierCounts: { application: 10, base: 4, all: 15 },
        criticalTierCounts: { application: 2, base: 90, all: 99 },
        limit: 3,
        offset: 0,
    };
}

function render(data: ClusterVulnerabilitiesResponse, lens: 'application' | 'base' | 'all' = 'application') {
    return renderToStaticMarkup(
        <MostCritical
            enabled
            data={data}
            error={null}
            isRefreshing={false}
            filters={{ lens, control: 'all' }}
            onLensChange={() => {}}
            onShowEveryImage={() => {}}
            fixIndex={EMPTY_FIX_INDEX}
            showClusterCount={false}
        />,
    );
}

/**
 * The block says how it ranks and shows the number each row is ranked by, so
 * a KEV-listed advisory in one image sitting above an idle critical in ten
 * reads as the rule, not a mistake.
 */
describe('MostCritical', () => {
    it('says the rows are ranked by the Risk Score they add, KEV first', () => {
        const html = render(response([row({ identity: 'CVE-2024-0001', vulnId: 'CVE-2024-0001' })]));
        expect(html).toContain(
            'Ranked by the Risk Score they add across running images (per-finding 0–100 × images carrying it). Anything on CISA KEV comes first.',
        );
    });

    it('carries an "Adds" column with each row’s total, formatted with thousands separators', () => {
        const html = render(
            response([
                row({
                    identity: 'CVE-2024-0001',
                    vulnId: 'CVE-2024-0001',
                    totalRiskScore: 9600,
                    findingCount: 10,
                    imageCount: 10,
                    containerCount: 12,
                }),
                row({
                    identity: 'CVE-2024-0002',
                    vulnId: 'CVE-2024-0002',
                    exploited: true,
                    kevListedAt: '2024-01-10T00:00:00.000Z',
                    totalRiskScore: 53,
                }),
            ]),
        );
        expect(html).toMatch(/<th[^>]*>Adds<\/th>/);
        expect(html).toContain('>9,600<');
        expect(html).toContain('>53<');
        expect(html).toContain(
            '10 findings add 9,600 to the Risk Score — what fixing CVE-2024-0001 everywhere takes off it',
        );
        expect(html).toContain(
            '1 finding adds 53 to the Risk Score — what fixing CVE-2024-0002 everywhere takes off it',
        );
    });

    it('renders a dash under Adds when nothing behind the row is scored', () => {
        const html = render(
            response([row({ identity: 'GHSA-xxxx', vulnId: 'GHSA-xxxx', riskScore: null, totalRiskScore: null })]),
        );
        expect(html).toContain('No finding behind this row is scored');
    });

    it('says what the lens leaves unranked, and that exploited findings are listed regardless', () => {
        const html = render(response([row({ identity: 'CVE-2024-0001', vulnId: 'CVE-2024-0001' })]), 'application');
        expect(html).toContain('Ranked over application packages only');
        expect(html).toContain('97 critical findings the lens hides');
        expect(html).toContain('are not ranked here. Exploited ones are listed regardless of the lens.');
    });
});
