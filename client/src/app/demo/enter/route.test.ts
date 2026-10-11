import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The route against a mocked client database. Nothing here needs Postgres:
 * the contract is "one session row, two hours, the Auth.js cookie, a
 * redirect", and the negative cases (not demo mode, bucket empty, seed not
 * run) never reach the database at all.
 */

type SessionRow = { sessionToken: string; userId: string; expires: Date };

const findFirst = vi.fn();
const insertValues = vi.fn<(row: SessionRow) => Promise<void>>(async () => undefined);
const deleteWhere = vi.fn<(condition: unknown) => Promise<void>>(async () => undefined);

vi.mock('@/db', () => ({
    db: {
        query: { users: { findFirst } },
        insert: () => ({ values: insertValues }),
        delete: () => ({ where: deleteWhere }),
    },
}));
vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const DEMO_USER = { id: '11111111-1111-4111-8111-111111111111', demo: true };

function makeRequest(headers: Record<string, string> = {}, url = 'http://demo.test/demo/enter') {
    return new NextRequest(url, { headers });
}

// The rate limiter and sweep clock are module state; a fresh module per test.
async function loadRoute() {
    vi.resetModules();
    return import('./route');
}

const envKeys = ['DEMO_MODE', 'DEMO_USER_EMAIL', 'AUTH_URL', 'NEXTAUTH_URL'] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
    for (const key of envKeys) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    process.env.DEMO_MODE = 'true';
    findFirst.mockReset();
    insertValues.mockClear();
    deleteWhere.mockClear();
    findFirst.mockResolvedValue(DEMO_USER);
});

afterEach(() => {
    for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    vi.useRealTimers();
});

describe('GET /demo/enter', () => {
    it('404s when demo mode is off, before touching the database', async () => {
        delete process.env.DEMO_MODE;
        const { GET } = await loadRoute();
        const res = await GET(makeRequest());
        expect(res.status).toBe(404);
        expect(findFirst).not.toHaveBeenCalled();
        expect(insertValues).not.toHaveBeenCalled();
    });

    it('creates one two-hour session, sets the Auth.js cookie and redirects to /', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-09-08T12:00:00Z');
        vi.setSystemTime(now);
        const { GET } = await loadRoute();

        const res = await GET(makeRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));

        expect(res.status).toBe(302);
        // Relative: the route cannot know its public host (see the comment
        // in the route), and the browser resolves it against the one it used.
        expect(res.headers.get('location')).toBe('/');
        expect(res.headers.get('cache-control')).toBe('no-store');

        expect(insertValues).toHaveBeenCalledTimes(1);
        const row = insertValues.mock.calls[0]![0];
        expect(row.userId).toBe(DEMO_USER.id);
        expect(row.expires.getTime() - now.getTime()).toBe(2 * 60 * 60 * 1000);
        expect(row.sessionToken.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url

        // http request → the unprefixed cookie, matching Auth.js's choice.
        const cookie = res.cookies.get('authjs.session-token');
        expect(cookie).toBeDefined();
        expect(cookie!.value).toBe(row.sessionToken);
        expect(cookie!.httpOnly).toBe(true);
        expect(cookie!.sameSite).toBe('lax');
        expect(cookie!.path).toBe('/');
        expect(cookie!.secure).toBeFalsy();
        expect(new Date(cookie!.expires!).getTime()).toBe(row.expires.getTime());
    });

    it('uses the __Secure- cookie when the request arrived over https', async () => {
        const { GET } = await loadRoute();
        const res = await GET(makeRequest({ 'x-forwarded-proto': 'https' }));
        const cookie = res.cookies.get('__Secure-authjs.session-token');
        expect(cookie).toBeDefined();
        expect(cookie!.secure).toBe(true);
        expect(res.cookies.get('authjs.session-token')).toBeUndefined();
    });

    it('lets AUTH_URL decide the cookie prefix over the request', async () => {
        process.env.AUTH_URL = 'https://demo.stackradar.io';
        const { GET } = await loadRoute();
        const res = await GET(makeRequest());
        expect(res.cookies.get('__Secure-authjs.session-token')).toBeDefined();
    });

    it('looks the demo user up by DEMO_USER_EMAIL and refuses a row not flagged demo', async () => {
        process.env.DEMO_USER_EMAIL = 'someone@example.com';
        findFirst.mockResolvedValue({ id: 'real-user', demo: false });
        const { GET } = await loadRoute();
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
        expect(insertValues).not.toHaveBeenCalled();
        expect(res.cookies.get('authjs.session-token')).toBeUndefined();
    });

    it('500s when the demo user does not exist (seed not run)', async () => {
        findFirst.mockResolvedValue(undefined);
        const { GET } = await loadRoute();
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
        expect(insertValues).not.toHaveBeenCalled();
    });

    it('429s once the per-IP bucket is empty, and other addresses are unaffected', async () => {
        const { GET } = await loadRoute();
        for (let i = 0; i < 10; i++) {
            expect((await GET(makeRequest({ 'x-forwarded-for': '198.51.100.1' }))).status).toBe(302);
        }
        const limited = await GET(makeRequest({ 'x-forwarded-for': '198.51.100.1' }));
        expect(limited.status).toBe(429);
        expect(limited.headers.get('retry-after')).toBe('60');
        expect(insertValues).toHaveBeenCalledTimes(10);

        expect((await GET(makeRequest({ 'x-forwarded-for': '198.51.100.2' }))).status).toBe(302);
    });

    it('sweeps day-old expired sessions at most once an hour', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
        const { GET } = await loadRoute();

        await GET(makeRequest());
        await GET(makeRequest());
        expect(deleteWhere).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-09-08T13:00:01Z'));
        await GET(makeRequest());
        expect(deleteWhere).toHaveBeenCalledTimes(2);
    });
});
