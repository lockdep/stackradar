import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider';
import { resolveEdition } from '@/lib/edition';

/**
 * The cluster Settings page for the three viewers it distinguishes, as
 * static markup: an admin outside the demo (every control live), a member
 * outside the demo (a sentence, no form) and the demo visitor — drawn as a
 * member — who gets the page read-only: the name field disabled, no Save,
 * no key rotation, no delete. The data hooks are stubbed to a cluster that
 * has a key, so the API key section renders.
 */
let role: 'owner' | 'admin' | 'member' = 'member';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/providers/OrganizationProvider', () => ({
    useOrganization: () => ({
        organization: { id: 'org-1', name: 'Acme', slug: 'acme', plan: 'team', role },
        organizations: [],
        setOrganization: () => {},
        addOrganization: () => {},
    }),
    isAdminOrOwner: (org: { role?: string } | null) => org?.role === 'owner' || org?.role === 'admin',
}));
vi.mock('@/components/clusters/ClusterContext', () => ({
    useCluster: () => ({
        cluster: { id: 'c1', name: 'platform-eu1', hasApiKey: true, scannerVersion: '0.7.0' },
        setClusterName: () => {},
        refetchCluster: async () => {},
    }),
}));
vi.mock('@/hooks', () => ({
    useResource: () => ({
        data: {
            apiKey: 'sr_live_••••••••abcd',
            createdAt: '2026-10-01T00:00:00.000Z',
            lastUsedAt: null,
            revealable: true,
            lastRevealedAt: null,
        },
        isLoading: false,
        lastUpdated: null,
        refetch: async () => {},
    }),
    usePollWhile: () => {},
    useRevalidateOnFocus: () => {},
}));

const { default: ClusterSettingsPage } = await import('./page');

function render(viewer: typeof role, demoMode: boolean) {
    role = viewer;
    return renderToStaticMarkup(
        <RuntimeConfigProvider
            config={{
                scannerChartVersion: '0.7.0',
                publicApiUrl: null,
                demoMode,
                edition: resolveEdition('cloud'),
                localLogin: false,
            }}
        >
            <ClusterSettingsPage />
        </RuntimeConfigProvider>,
    );
}

/** The cluster-name input's attributes, so `disabled` can be asserted on it alone. */
function nameInput(html: string): string {
    const match = /<input[^>]*aria-label="Cluster name"[^>]*>/.exec(html);
    expect(match, 'the cluster name input').not.toBeNull();
    return match![0];
}

describe('ClusterSettingsPage', () => {
    it('gives an admin every control', () => {
        const html = render('admin', false);
        expect(html).toContain('General');
        // The attribute, not the `disabled:` style variants the class list carries.
        expect(nameInput(html)).not.toContain('disabled=""');
        expect(html).toContain('>Save<');
        expect(html).toContain('Rotate key');
        expect(html).toContain('Delete cluster');
        expect(html).not.toContain('Read-only in the demo');
    });

    it('still shows a member outside the demo nothing but the sentence', () => {
        const html = render('member', false);
        expect(html).toContain('Only organization admins and owners can manage cluster settings.');
        expect(html).not.toContain('General');
        expect(html).not.toContain('<input');
        expect(html).not.toContain('>Save<');
    });

    it('shows the demo visitor the page read-only: fields disabled, no save, rotate or delete', () => {
        const html = render('member', true);
        expect(html).toContain('Read-only in the demo');
        expect(html).toContain('General');
        expect(nameInput(html)).toContain('disabled=""');
        expect(html).toContain('platform-eu1');
        // The scanner configuration surface is what the evaluator came for.
        expect(html).toContain('Scanner connection');
        expect(html).toContain('View instructions');
        expect(html).toContain('API key');
        expect(html).toContain('sr_live_••••••••abcd');
        // And none of the writes the server would refuse.
        expect(html).not.toContain('>Save<');
        expect(html).not.toContain('Rotate key');
        expect(html).not.toContain('Reveal key');
        expect(html).not.toContain('Delete cluster');
    });
});
