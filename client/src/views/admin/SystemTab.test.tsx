import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AdminSystemData } from '@/app/api/admin/system/route';

/**
 * The System tab against a report the BFF route would hand it: a community
 * install whose server schema is current, whose auth schema is one
 * migration behind the build, and whose mirror carries fewer ecosystems
 * than are configured. Static markup; the data hook is replaced with the
 * fixture. What is asserted is that each fact the operator came for is on
 * the page, in the words the tab uses for it.
 */
const report: AdminSystemData = {
    build: { version: '0.2.0+abc1234', node: 'v24.1.0', startedAt: '2026-10-18T06:00:00.000Z', uptimeSeconds: 7260 },
    client: {
        version: '0.2.0+abc1234',
        node: 'v24.1.0',
        signIn: [
            { id: 'password', label: 'Username and password' },
            { id: 'oidc', label: 'OIDC (Keycloak)' },
        ],
        oidcAdminGroup: true,
    },
    edition: { value: 'community', source: 'default' },
    topology: { value: 'monolith', source: 'default' },
    config: [
        { key: 'OSV_ECOSYSTEMS', value: 'Alpine, Debian, npm', source: 'set' },
        { key: 'IMAGE_GC_RETENTION_DAYS', value: '30 days', source: 'default' },
        { key: 'API_KEY_ENCRYPTION_KEY', value: 'configured', source: 'set' },
    ],
    mirror: {
        configuredEcosystems: ['Alpine', 'Debian', 'npm'],
        liveEcosystems: ['Alpine', 'Debian'],
        matchesConfig: false,
    },
    migrations: {
        server: {
            applied: 29,
            latestAppliedAt: '2026-10-17T00:00:00.000Z',
            latestTag: '0028_sync_state_progress',
            chainLength: 29,
            chainLatestTag: '0028_sync_state_progress',
            current: true,
        },
        auth: {
            applied: 1,
            latestAppliedAt: '2026-10-08T00:00:00.000Z',
            latestTag: '0000_auth_schema',
            chainLength: 2,
            chainLatestTag: '0001_users_is_admin',
            current: false,
        },
    },
};

vi.mock('./useTabData', () => ({
    useTabData: () => ({ data: report, isLoading: false, error: null, refetch: () => {}, reloadKey: 0 }),
}));

const { SystemTab } = await import('./SystemTab');

describe('SystemTab', () => {
    const html = renderToStaticMarkup(<SystemTab refreshKey={0} onLoadingChange={() => {}} />);

    it('renders the three cards', () => {
        for (const heading of ['Build', 'Configuration', 'Database']) expect(html, heading).toContain(heading);
    });

    it('shows both versions, the edition and the topology with where each came from', () => {
        expect(html).toContain('0.2.0+abc1234');
        expect(html).toContain('community');
        expect(html).toContain('monolith');
        expect(html).toContain('>default<');
        expect(html).toContain('>set<');
    });

    it('lists every knob by its variable name and the sign-in methods by label', () => {
        for (const key of ['OSV_ECOSYSTEMS', 'IMAGE_GC_RETENTION_DAYS', 'API_KEY_ENCRYPTION_KEY']) {
            expect(html, key).toContain(key);
        }
        expect(html).toContain('configured');
        expect(html).toContain('Username and password');
        expect(html).toContain('OIDC (Keycloak)');
        expect(html).toContain('re-evaluated at every sign-in');
    });

    it('says the server schema is current and the auth schema is behind, naming the tags', () => {
        expect(html).toContain('current');
        expect(html).toContain('behind this build');
        expect(html).toContain('0028_sync_state_progress');
        expect(html).toContain('0000_auth_schema');
        expect(html).toContain('0001_users_is_admin');
        expect(html).toContain('1 of 2 in this build');
    });

    it('warns when the mirror carries less than is configured', () => {
        expect(html).toContain('Alpine, Debian, npm');
        expect(html).toContain('Alpine, Debian<');
        expect(html).toContain('does not carry what is configured');
    });
});
