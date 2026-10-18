import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider';
import { resolveEdition, type Edition } from '@/lib/edition';

/**
 * The admin page's tab strip under each edition, as static markup. Every tab
 * declares the capability it needs and the page filters on that alone, so
 * what is asserted here is the table in
 * `docs/plans/admin-view-two-editions.md`: which tabs a self-hosting admin
 * sees, which the cloud operator sees, and that the tenant surface — the
 * word "organization" anywhere on the page — is absent from the community
 * edition. The tabs' data hook is stubbed to "still loading", so no tab body
 * renders beyond its shell.
 */
vi.mock('next/navigation', () => ({
    usePathname: () => '/admin',
    useRouter: () => ({ push: () => {} }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/views/admin/useTabData', () => ({
    useTabData: () => ({ data: null, isLoading: true, error: null, refetch: () => {}, reloadKey: 0 }),
}));

const { default: AdminPage } = await import('./page');

function render(edition: Edition, localLogin: boolean) {
    return renderToStaticMarkup(
        <RuntimeConfigProvider
            config={{
                scannerChartVersion: null,
                publicApiUrl: null,
                demoMode: false,
                edition: resolveEdition(edition),
                localLogin,
            }}
        >
            <AdminPage />
        </RuntimeConfigProvider>,
    );
}

/** The tab labels the strip renders, in order. */
function tabs(html: string): string[] {
    return [...html.matchAll(/role="tab"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1].trim());
}

describe('AdminPage', () => {
    it('shows a self-hosting admin the install, not a platform', () => {
        const html = render('community', true);
        expect(tabs(html)).toEqual([
            'Overview',
            'System',
            'Jobs',
            'Images',
            'Explorer',
            'Vulnerabilities',
            'Matcher',
            'OSV Sync',
            'Feeds',
            'Users',
        ]);
        // The section labels, once each, in reading order; the Index group has nothing here.
        expect(html.indexOf('>Health<')).toBeLessThan(html.indexOf('>Data<'));
        expect(html.indexOf('>Data<')).toBeLessThan(html.indexOf('>Advisories<'));
        expect(html.indexOf('>Advisories<')).toBeLessThan(html.indexOf('>People<'));
        expect(html).not.toContain('>Index<');
        expect(html).toContain('Administration');
        expect(html).toContain('health, data and accounts');
        expect(html.toLowerCase()).not.toContain('organization');
        expect(html.toLowerCase()).not.toContain('plan');
        expect(html).not.toContain('Platform');
    });

    it('drops the Users tab when local login is off', () => {
        const html = render('community', false);
        expect(tabs(html)).not.toContain('Users');
    });

    it('shows the cloud operator every tab but Users', () => {
        const html = render('cloud', false);
        expect(tabs(html)).toEqual([
            'Overview',
            'System',
            'Jobs',
            'Images',
            'Explorer',
            'Vulnerabilities',
            'Matcher',
            'OSV Sync',
            'Feeds',
            'Organizations',
            'Feedback',
            'Chart Index',
        ]);
        expect(html).toContain('>Index<');
        expect(html).toContain('Admin Dashboard');
        expect(html).toContain('Platform-wide health and statistics');
    });
});
