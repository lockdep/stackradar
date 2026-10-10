import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider'
import { resolveEdition } from '@/lib/edition'
import { SearchProvider } from '@/components/search'

/**
 * The sidebar in and out of demo mode, as static markup. The nav does not
 * need a router to render its links, so only the hooks that read one — and
 * the org / theme contexts — are stubbed. What is asserted is the property
 * the live demo rests on: `demoMode: false` is the sidebar as shipped, and
 * `demoMode: true` swaps exactly the two entries that would post.
 */
vi.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push: () => {} }),
}))
vi.mock('next-auth/react', () => ({ signOut: () => {} }))
vi.mock('@/components/providers/OrganizationProvider', () => ({
    useOrganization: () => ({
        organization: { id: 'org-1', name: 'Demo', slug: 'demo', plan: 'team', role: 'member' },
        organizations: [{ id: 'org-1', name: 'Demo', slug: 'demo', plan: 'team', role: 'member' }],
        setOrganization: () => {},
        addOrganization: () => {},
    }),
    isAdminOrOwner: () => false,
}))
vi.mock('@/components/providers/ThemeProvider', () => ({
    useTheme: () => ({ theme: 'system', setTheme: () => {} }),
}))

const { Sidebar } = await import('./Sidebar')

function render(demoMode: boolean) {
    return renderToStaticMarkup(
        <RuntimeConfigProvider config={{ scannerChartVersion: null, demoMode, edition: resolveEdition('cloud'), localLogin: false }}>
            <SearchProvider>
                <Sidebar
                    sidebarOpen={false}
                    setSidebarOpen={() => {}}
                    onOrganizationChange={() => {}}
                    userName="Demo visitor"
                    userImage={null}
                    userEmail="demo@stackradar.io"
                />
            </SearchProvider>
        </RuntimeConfigProvider>,
    )
}

describe('Sidebar', () => {
    it('ships the feedback entry and the create-organization entry when demo mode is off', () => {
        const html = render(false)
        expect(html).toContain('Send feedback')
        expect(html).not.toContain('Scan your own cluster')
        expect(html).toContain('Dashboard')
        expect(html).toContain('Containers')
        expect(html).toContain('Clusters')
    })

    it('orders the nav as the daily workflow: verdict, evidence, what runs, changes, then infrastructure', () => {
        const html = render(false)
        // Fixes is switched off (lib/features.ts) and must not be in the nav.
        expect(html).not.toContain('/fixes')
        const order = ['Dashboard', '/vulnerabilities', '/packages', '/containers', '/images', '/feed', '/clusters']
            .map(needle => html.indexOf(needle))
        expect(order.every(i => i >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    it('carries the global search trigger directly under the organization, in both demo states', () => {
        for (const demoMode of [false, true]) {
            const html = render(demoMode)
            const org = html.indexOf('Demo')
            const search = html.indexOf('Search…')
            const dashboard = html.indexOf('Dashboard')
            expect(search).toBeGreaterThan(org)
            expect(search).toBeLessThan(dashboard)
            expect(html).toMatch(/<kbd[^>]*><span>⌘<\/span><span>K<\/span><\/kbd>/)
        }
    })

    it('replaces feedback with the CLI link in demo mode and keeps the rest', () => {
        const html = render(true)
        expect(html).not.toContain('Send feedback')
        expect(html).toContain('Scan your own cluster')
        expect(html).toContain('https://stackradar.io/open-source/cli')
        expect(html).toContain('Dashboard')
        expect(html).toContain('Containers')
        expect(html).toContain('Clusters')
        expect(html).toContain('Help')
        expect(html).toContain('Demo visitor')
    })
})
