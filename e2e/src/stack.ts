import path from 'node:path';

/**
 * Where the stack is and what it was started with. Every value is the
 * Compose quickstart's public fixture (deploy/compose/docker-compose.yml)
 * unless an E2E_* variable says otherwise; the ports are the ones
 * scripts/stack.sh binds.
 */
const uiPort = process.env.E2E_UI_PORT ?? '3200';
const apiPort = process.env.E2E_API_PORT ?? '8280';

export const stack = {
    /** The client, as a browser reaches it. */
    baseUrl: process.env.E2E_BASE_URL ?? `http://localhost:${uiPort}`,
    /** The server's public API (`/v1/*`), as a scanner would reach it. */
    apiUrl: process.env.E2E_API_URL ?? `http://localhost:${apiPort}`,
    /** The cluster-scoped scanner key the quickstart seeds (BOOTSTRAP_CLUSTER_API_KEY). */
    scannerKey: process.env.E2E_SCANNER_KEY ?? 'stackradar-fixture-bootstrap-scanner-key',
    /** The bootstrap admin (AUTH_BOOTSTRAP_ADMIN_EMAIL / _PASSWORD) and the password the first sign-in replaces it with. */
    admin: {
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@stackradar.local',
        bootstrapPassword: process.env.E2E_ADMIN_BOOTSTRAP_PASSWORD ?? 'admin',
        password: process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password-9f3k',
    },
    /** The name DEFAULT_CLUSTER_NAME gives the install's one cluster. */
    clusterName: 'local',
    /** The one organisation of a community install, as the sidebar names it. */
    orgName: 'Default organization',
    /** A second, non-admin local account the stateful suite creates through the admin's Users tab. */
    member: {
        email: process.env.E2E_MEMBER_EMAIL ?? 'member@stackradar.local',
        initialPassword: 'member-initial-password-1',
        password: process.env.E2E_MEMBER_PASSWORD ?? 'e2e-member-password-7q2m',
    },
    /** True when E2E_BASE_URL was given: the stack is someone else's and global setup must not start or stop one. */
    external: Boolean(process.env.E2E_BASE_URL),
} as const;

export const repoRoot = path.resolve(__dirname, '..', '..');
export const fixtures = {
    /** CycloneDX SBOM of nginx:1.27-alpine, the one docs/self-hosting/docker-compose.md uploads by hand. */
    nginxSbom: path.join(repoRoot, 'server', 'tests', 'fixtures', 'nginx-1.27-alpine.deep-squashed.cdx.json'),
} as const;

/** The signed-in browser state auth.setup.ts writes and every test project reads. */
export const adminStorageState = path.join(__dirname, '..', '.auth', 'admin.json');
