// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import fixture from './__fixtures__/chart-index-status.json';
import type { ChartIndexStatus } from './types';

/**
 * The Chart Index tab rendered against a payload the chart index site
 * actually produced (`__fixtures__/chart-index-status.json`, dumped from its
 * status endpoint over a seeded chart world). The point is the contract:
 * every section reads the shape that site writes, so a field renamed there
 * fails here before it fails in the dashboard. Static markup — no effects,
 * no fetch; the data hook is replaced with the fixture.
 */
const status = fixture as unknown as ChartIndexStatus;

vi.mock('@/views/admin/useTabData', () => ({
    useTabData: () => ({ data: status, isLoading: false, error: null, refetch: () => {}, reloadKey: 0 }),
}));

const { ChartIndexTab } = await import('./ChartIndexTab');

describe('ChartIndexTab', () => {
    const html = renderToStaticMarkup(<ChartIndexTab refreshKey={0} onLoadingChange={() => {}} />);

    it('renders every section', () => {
        for (const heading of [
            'Pipeline',
            'Freshness',
            'Scores',
            'Catalogue',
            'Inventory',
            'Recent runs',
            'Database',
        ]) {
            expect(html, heading).toContain(heading);
        }
    });

    it('shows each task with its last outcome', () => {
        for (const label of ['Select', 'Render', 'Prune', 'Inventory', 'Match', 'Score', 'Trending']) {
            expect(html, label).toContain(label);
        }
        // The fixture's render run failed with this error; select never finished; prune never ran.
        expect(html).toContain('helm: boom');
        expect(html).toContain('Unfinished');
        expect(html).toContain('Never ran');
        expect(html).toContain('Failed');
    });

    it('reads the inventory section: the claim in flight and the spent failure', () => {
        expect(html).toContain('charts-scanner-7f9c-abc12:1');
        expect(html).toContain('syft exited 1: manifest unknown');
        expect(html).toContain('library/claimed');
    });

    it('shows the schedules and the database tables', () => {
        expect(html).toContain('15 4 * * *');
        expect(html).toContain('0 7 * * *');
        expect(html).toContain('30 7 * * *');
        for (const table of ['runs', 'images', 'sboms', 'chart_versions']) expect(html).toContain(table);
    });

    it("summarises a run's stats from its keys", () => {
        // The inventory run's stats line: `componentsTotal` → "components total".
        expect(html).toContain('41,230 components total');
    });
});
