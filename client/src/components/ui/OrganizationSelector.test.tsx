import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider'
import { resolveEdition, type Edition } from '@/lib/edition'

/**
 * The organization menu per edition, as static markup
 * (docs/open-source-plan-2026-10-10.md step 03 §4). The property under
 * test: the switcher and "Create organization" follow `edition.multiOrg`,
 * never the number of organizations — the fixture has two, and the
 * community edition still draws neither.
 */
vi.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push: () => {} }),
}))
/* A closed Headless UI menu renders no items, and static markup cannot
   open one; each menu part becomes a plain element so the menu's contents
   are what is rendered. The create-organization dialog is a stub for the
   same reason — what is asserted is whether it is mounted at all. */
vi.mock('@headlessui/react', () => {
    const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
    return {
        Menu: passthrough,
        MenuButton: passthrough,
        MenuHeading: passthrough,
        MenuItem: passthrough,
        MenuItems: passthrough,
        MenuSection: passthrough,
        MenuSeparator: () => <hr />,
    }
})
vi.mock('./CreateOrganizationModal', () => ({
    CreateOrganizationModal: () => <div>create-organization-modal</div>,
}))
const orgs = [
    { id: 'org-1', name: 'Default organization', slug: 'default', plan: 'community', role: 'owner' },
    { id: 'org-2', name: 'Other', slug: 'other', plan: 'free', role: 'member' },
]
vi.mock('@/components/providers/OrganizationProvider', () => ({
    useOrganization: () => ({
        organization: orgs[0],
        organizations: orgs,
        setOrganization: () => {},
        addOrganization: () => {},
    }),
    isAdminOrOwner: () => true,
}))

const { OrganizationSelector } = await import('./OrganizationSelector')

function render(edition: Edition) {
    return renderToStaticMarkup(
        <RuntimeConfigProvider config={{ scannerChartVersion: null, demoMode: false, edition: resolveEdition(edition), localLogin: false }}>
            <OrganizationSelector />
        </RuntimeConfigProvider>,
    )
}

describe('OrganizationSelector', () => {
    it('on the cloud: manage links, the switcher and "Create organization"', () => {
        const html = render('cloud')
        expect(html).toContain('Settings')
        expect(html).toContain('Members')
        expect(html).toContain('Billing')
        expect(html).toContain('Switch organization')
        expect(html).toContain('Create organization')
        expect(html).toContain('create-organization-modal')
        expect(html).toContain('Other')
    })

    it('in the community edition: manage links only, whatever the count of organizations', () => {
        const html = render('community')
        expect(html).toContain('Settings')
        expect(html).toContain('Members')
        expect(html).not.toContain('Billing')
        expect(html).not.toContain('Switch organization')
        expect(html).not.toContain('Create organization')
        expect(html).not.toContain('create-organization-modal')
        expect(html).not.toContain('Other')
        expect(html).toContain('Community edition')
    })
})
