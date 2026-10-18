import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { readFileSync } from 'node:fs';

/**
 * The System tab's BFF route against a mocked session and a mocked Express.
 * The contract: admin-only like every `admin/*` path; the server's report
 * passes through and this app's half is added — its version, which sign-in
 * methods are on, the auth chain's verdict from this app's own journal —
 * and nothing that could sign a request leaves with it.
 */

const authMock = vi.fn<() => Promise<Session | null>>();
vi.mock('@/auth', () => ({ auth: () => authMock() }));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const { GET } = await import('./route');

const EXPRESS = 'http://express.test:8080';
const ORGS = [{ id: 'org-a', name: 'Org A', slug: 'org-a', plan: 'community' }];

function session(over: Partial<Session['user']> = {}): Session {
    return {
        user: {
            id: 'user-1',
            email: 'u@example.test',
            name: 'Admin',
            isAdmin: true,
            mustChangePassword: false,
            ...over,
        },
        expires: '2099-01-01T00:00:00.000Z',
    };
}

const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf-8')) as {
    entries: Array<{ when: number; tag: string }>;
};
const newest = journal.entries[journal.entries.length - 1]!;

function serverReport(auth: { applied: number | null; latestAppliedAt: string | null }) {
    return {
        build: { version: '0.2.0', node: 'v24', startedAt: '2026-10-18T00:00:00.000Z', uptimeSeconds: 1 },
        edition: { value: 'community', source: 'default' },
        topology: { value: 'monolith', source: 'default' },
        config: [],
        mirror: { configuredEcosystems: null, liveEcosystems: undefined, matchesConfig: false },
        migrations: {
            server: {
                applied: 1,
                latestAppliedAt: null,
                latestTag: null,
                chainLength: 1,
                chainLatestTag: 'x',
                current: true,
            },
            auth,
        },
    };
}

const fetchMock = vi.fn<typeof fetch>();

function upstream(report: unknown, status = 200) {
    fetchMock.mockImplementation(async (input) => {
        if (String(input).endsWith('/api/users/organizations')) return Response.json({ organizations: ORGS });
        return new Response(JSON.stringify(report), { status, headers: { 'Content-Type': 'application/json' } });
    });
}

const request = () => new NextRequest('http://app.test/api/admin/system');

beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-key-xyz';
    process.env.EXPRESS_API_URL = EXPRESS;
    process.env.STACKRADAR_EDITION = 'community';
    delete process.env.AUTH_LOCAL_ENABLED;
    delete process.env.AUTH_OIDC_ISSUER;
    delete process.env.AUTH_OIDC_ID;
    delete process.env.AUTH_OIDC_SECRET;
    delete process.env.AUTH_OIDC_ADMIN_GROUP;
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    authMock.mockReset();
    authMock.mockResolvedValue(session());
    upstream(serverReport({ applied: null, latestAppliedAt: null }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('GET /api/admin/system', () => {
    it('401s without a session and 403s a non-admin, before anything is fetched', async () => {
        authMock.mockResolvedValueOnce(null);
        expect((await GET(request())).status).toBe(401);
        authMock.mockResolvedValueOnce(session({ isAdmin: false }));
        expect((await GET(request())).status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('asks Express as the admin and adds this app’s half', async () => {
        process.env.AUTH_OIDC_ISSUER = 'https://idp.test';
        process.env.AUTH_OIDC_ID = 'client-id-123';
        process.env.AUTH_OIDC_SECRET = 'client-secret-456';
        process.env.AUTH_OIDC_NAME = 'Keycloak';
        process.env.AUTH_OIDC_ADMIN_GROUP = 'platform-admins';

        const res = await GET(request());
        expect(res.status).toBe(200);
        const body = await res.json();

        const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/admin/system'));
        expect(call).toBeDefined();
        const headers = (call![1]!.headers ?? {}) as Record<string, string>;
        expect(headers['X-Internal-Key']).toBe('test-internal-key-xyz');
        expect(headers['X-Is-Admin']).toBe('true');

        expect(body.build.version).toBe('0.2.0');
        expect(body.client.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(body.client.signIn).toEqual([
            { id: 'password', label: 'Username and password' },
            { id: 'oidc', label: 'OIDC (Keycloak)' },
        ]);
        expect(body.client.oidcAdminGroup).toBe(true);

        const text = JSON.stringify(body);
        for (const secret of ['test-internal-key-xyz', 'client-id-123', 'client-secret-456']) {
            expect(text).not.toContain(secret);
        }
    });

    it('judges the auth chain against this app’s journal', async () => {
        upstream(
            serverReport({
                applied: journal.entries.length,
                latestAppliedAt: new Date(newest.when).toISOString(),
            }),
        );
        const current = await (await GET(request())).json();
        expect(current.migrations.auth).toMatchObject({
            current: true,
            latestTag: newest.tag,
            chainLength: journal.entries.length,
            chainLatestTag: newest.tag,
        });

        upstream(serverReport({ applied: 1, latestAppliedAt: new Date(newest.when - 1).toISOString() }));
        const behind = await (await GET(request())).json();
        expect(behind.migrations.auth.current).toBe(false);

        upstream(serverReport({ applied: null, latestAppliedAt: null }));
        const never = await (await GET(request())).json();
        expect(never.migrations.auth).toMatchObject({ applied: null, latestTag: null, current: false });
    });

    it('passes an Express refusal through with its status', async () => {
        upstream({ error: 'nope' }, 503);
        const res = await GET(request());
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'nope' });
    });
});
