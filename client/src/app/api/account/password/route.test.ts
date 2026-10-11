import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { hashPassword, verifyPassword } from '@/lib/password';

type UserRow = { id: string; passwordHash: string | null; mustChangePassword?: boolean };

const auth = vi.fn();
const findFirst = vi.fn<() => Promise<UserRow | undefined>>();
const updateSet = vi.fn();
const updateWhere = vi.fn(async () => undefined);
const deleteWhere = vi.fn(async () => undefined);

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => auth(...args) }));
vi.mock('@/db', () => ({
    db: {
        query: { users: { findFirst } },
        update: () => ({ set: (patch: unknown) => (updateSet(patch), { where: updateWhere }) }),
        delete: () => ({ where: deleteWhere }),
    },
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const { GET, POST } = await import('./route');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CURRENT = 'the current password';
let HASH: string;

function post(body: unknown, cookie?: string) {
    return new NextRequest('http://app.test/api/account/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
    });
}

beforeEach(async () => {
    HASH ??= await hashPassword(CURRENT);
    delete process.env.STACKRADAR_EDITION;
    delete process.env.AUTH_LOCAL_ENABLED;
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: USER_ID, isAdmin: false, mustChangePassword: false } });
    findFirst.mockReset();
    findFirst.mockResolvedValue({ id: USER_ID, passwordHash: HASH, mustChangePassword: true });
    updateSet.mockClear();
    updateWhere.mockClear();
    deleteWhere.mockClear();
});

describe('GET /api/account/password', () => {
    it('reports whether the account has a password and must change it', async () => {
        expect(await (await GET()).json()).toEqual({ hasPassword: true, mustChangePassword: true });
        findFirst.mockResolvedValue({ id: USER_ID, passwordHash: null, mustChangePassword: false });
        expect(await (await GET()).json()).toEqual({ hasPassword: false, mustChangePassword: false });
    });

    it('401s without a session and 404s when local login is off', async () => {
        auth.mockResolvedValue(null);
        expect((await GET()).status).toBe(401);
        auth.mockResolvedValue({ user: { id: USER_ID } });
        process.env.STACKRADAR_EDITION = 'cloud';
        expect((await GET()).status).toBe(404);
    });
});

describe('POST /api/account/password', () => {
    it('changes the password, clears the forced-change flag and lockout, and revokes the other sessions', async () => {
        const res = await POST(
            post({ currentPassword: CURRENT, newPassword: 'a brand new password' }, 'authjs.session-token=keep-me'),
        );
        expect(res.status).toBe(200);

        const patch = updateSet.mock.calls[0]![0] as {
            passwordHash: string;
            mustChangePassword: boolean;
            failedLogins: number;
            lockedUntil: null;
        };
        expect(await verifyPassword(patch.passwordHash, 'a brand new password')).toBe(true);
        expect(patch.mustChangePassword).toBe(false);
        expect(patch.failedLogins).toBe(0);
        expect(patch.lockedUntil).toBeNull();
        expect(deleteWhere).toHaveBeenCalledTimes(1);
    });

    it('403s a wrong current password and writes nothing', async () => {
        const res = await POST(post({ currentPassword: 'not it', newPassword: 'a brand new password' }));
        expect(res.status).toBe(403);
        expect(updateWhere).not.toHaveBeenCalled();
        expect(deleteWhere).not.toHaveBeenCalled();
    });

    it('enforces the policy and refuses a no-op change', async () => {
        expect((await POST(post({ currentPassword: CURRENT, newPassword: 'short' }))).status).toBe(400);
        expect((await POST(post({ currentPassword: CURRENT, newPassword: CURRENT }))).status).toBe(400);
        expect(updateWhere).not.toHaveBeenCalled();
    });

    it('tells a provider-only account it has no password here', async () => {
        findFirst.mockResolvedValue({ id: USER_ID, passwordHash: null });
        const res = await POST(post({ currentPassword: 'x', newPassword: 'a brand new password' }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/identity provider/);
    });

    it('401s without a session; 404s when local login is off', async () => {
        auth.mockResolvedValue(null);
        expect((await POST(post({}))).status).toBe(401);
        auth.mockResolvedValue({ user: { id: USER_ID } });
        process.env.AUTH_LOCAL_ENABLED = 'false';
        expect((await POST(post({}))).status).toBe(404);
    });
});
