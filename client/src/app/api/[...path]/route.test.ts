import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { ACTIVE_ORG_COOKIE } from '@/lib/constants';

/**
 * The catch-all proxy against a mocked session and a mocked `fetch`. The
 * contract: nothing leaves the pod without a session; what leaves carries
 * the service key, the user's identity and an org the user is actually a
 * member of; and what comes back is the upstream status and body under a
 * header set of exactly Content-Type (+ Content-Disposition), nothing else.
 */

const authMock = vi.fn<() => Promise<Session | null>>();
vi.mock('@/auth', () => ({ auth: () => authMock() }));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const { GET, POST } = await import('./route');

const EXPRESS = 'http://express.test:8080';
const ORGS = [
    { id: 'org-a', name: 'Org A', slug: 'org-a', plan: 'free' },
    { id: 'org-b', name: 'Org B', slug: 'org-b', plan: 'pro' },
];

function session(over: Partial<Session['user']> = {}): Session {
    return {
        user: {
            id: 'user-1',
            email: 'u@example.test',
            name: 'Ünïcode Name',
            isAdmin: false,
            mustChangePassword: false,
            ...over,
        },
        expires: '2099-01-01T00:00:00.000Z',
    };
}

const fetchMock = vi.fn<typeof fetch>();

/** The upstream response the proxied call gets; the org lookup always answers `ORGS`. */
function upstream(response: () => Response) {
    fetchMock.mockImplementation(async (input) => {
        if (String(input).endsWith('/api/users/organizations')) return Response.json({ organizations: ORGS });
        return response();
    });
}

/** The call that reached Express for the request under test, not the org lookup. */
function proxied(): { url: string; init: RequestInit & { duplex?: string } } {
    const call = fetchMock.mock.calls.find(([input]) => !String(input).endsWith('/api/users/organizations'));
    if (!call) throw new Error('nothing was proxied');
    return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit & { duplex?: string } };
}

function request(path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
    const req = new NextRequest(`http://app.test/api/${path}`, init);
    const segments = path.split('?')[0]!.split('/').map(decodeURIComponent);
    return [req, { params: Promise.resolve({ path: segments }) }] as const;
}

beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-key';
    process.env.EXPRESS_API_URL = EXPRESS;
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    authMock.mockReset();
    authMock.mockResolvedValue(session());
    upstream(() => Response.json({ ok: true }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('BFF catch-all proxy', () => {
    it('401s without a session, before anything is forwarded', async () => {
        authMock.mockResolvedValue(null);
        const res = await GET(...request('clusters'));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('forwards to the same path with the service key, the user headers and the first org', async () => {
        const res = await GET(...request('clusters?limit=5'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });

        const { url, init } = proxied();
        expect(url).toBe(`${EXPRESS}/api/clusters?limit=5`);
        expect(init.method).toBe('GET');
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Internal-Key']).toBe('test-internal-key');
        expect(headers['X-User-Id']).toBe('user-1');
        expect(headers['X-User-Email']).toBe('u%40example.test');
        // Header values must be Latin-1; names are percent-encoded on the way out.
        expect(headers['X-User-Name']).toBe(encodeURIComponent('Ünïcode Name'));
        expect(headers['X-Org-Id']).toBe('org-a');
        expect(headers['X-Org-Slug']).toBe('org-a');
        expect(headers['X-Request-Id']).toMatch(/\S/);
        expect(headers['X-Is-Admin']).toBeUndefined();
        expect(init.body).toBeUndefined();
    });

    it('re-encodes path segments that contain reserved characters', async () => {
        await GET(...request('images/sha256%3Aabc%2Fdef'));
        expect(proxied().url).toBe(`${EXPRESS}/api/images/sha256%3Aabc%2Fdef`);
    });

    it("honours the sr_org_id cookie when it names one of the user's orgs", async () => {
        await GET(...request('clusters', { headers: { cookie: `${ACTIVE_ORG_COOKIE}=org-b` } }));
        const headers = proxied().init.headers as Record<string, string>;
        expect(headers['X-Org-Id']).toBe('org-b');
        expect(headers['X-Org-Plan']).toBe('pro');
    });

    it('falls back to the first membership when the cookie names an org the user is not in', async () => {
        await GET(...request('clusters', { headers: { cookie: `${ACTIVE_ORG_COOKIE}=org-somebody-elses` } }));
        const headers = proxied().init.headers as Record<string, string>;
        expect(headers['X-Org-Id']).toBe('org-a');
    });

    it('sends no org headers for a user with no memberships yet', async () => {
        fetchMock.mockImplementation(async (input) =>
            String(input).endsWith('/api/users/organizations')
                ? Response.json({ organizations: [] })
                : Response.json({ ok: true }),
        );
        await GET(...request('users/me'));
        const headers = proxied().init.headers as Record<string, string>;
        expect(headers['X-Org-Id']).toBeUndefined();
        expect(headers['X-User-Id']).toBe('user-1');
    });

    it('403s admin/* for a non-admin and marks the request for an admin', async () => {
        const denied = await GET(...request('admin/organizations'));
        expect(denied.status).toBe(403);
        expect(fetchMock).not.toHaveBeenCalled();

        authMock.mockResolvedValue(session({ isAdmin: true }));
        const allowed = await GET(...request('admin/organizations'));
        expect(allowed.status).toBe(200);
        expect((proxied().init.headers as Record<string, string>)['X-Is-Admin']).toBe('true');
    });

    it("streams a POST body through with the caller's Content-Type", async () => {
        await POST(
            ...request('clusters', {
                method: 'POST',
                headers: { 'content-type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ name: 'prod' }),
            }),
        );
        const { init } = proxied();
        expect(init.method).toBe('POST');
        expect(init.duplex).toBe('half');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json; charset=utf-8');
        expect(await new Response(init.body).text()).toBe(JSON.stringify({ name: 'prod' }));
    });

    it('passes the upstream status and body back under Content-Type and Content-Disposition only', async () => {
        upstream(
            () =>
                new Response('{"id":"sbom-1"}', {
                    status: 202,
                    headers: {
                        'content-type': 'application/vnd.cyclonedx+json',
                        'content-disposition': 'attachment; filename="sbom.json"',
                        'set-cookie': 'upstream=leaked; Path=/',
                        'x-powered-by': 'Express',
                        'access-control-allow-origin': '*',
                    },
                }),
        );
        const res = await GET(...request('sboms/sbom-1/document?download=1'));
        expect(res.status).toBe(202);
        expect(await res.text()).toBe('{"id":"sbom-1"}');
        expect(res.headers.get('content-type')).toBe('application/vnd.cyclonedx+json');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="sbom.json"');
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('x-powered-by')).toBeNull();
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('defaults the Content-Type to JSON when the upstream sends none', async () => {
        // Bytes, not a string: a string body makes `Response` add text/plain itself.
        upstream(() => new Response(new TextEncoder().encode('{}'), { status: 200 }));
        const res = await GET(...request('clusters'));
        expect(res.headers.get('content-type')).toBe('application/json');
    });

    it('answers 500 with the error when Express is unreachable', async () => {
        upstream(() => {
            throw new TypeError('fetch failed');
        });
        const res = await GET(...request('clusters'));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'fetch failed' });
    });
});
