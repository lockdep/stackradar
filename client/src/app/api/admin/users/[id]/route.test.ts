import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Granting and revoking the platform-admin flag, against a mocked database.
 * The property under test is that an install cannot administer itself out
 * of existence: the last admin stays an admin, the demo account never
 * becomes one, and everything else is a plain column write by an admin.
 */
type UserRow = { id: string; isAdmin: boolean; demo: boolean };

const auth = vi.fn();
const findFirst = vi.fn<() => Promise<UserRow | undefined>>();
const selectWhere = vi.fn<() => Promise<Array<{ n: number }>>>();
const updateSet = vi.fn();
const updateWhere = vi.fn(async () => undefined);

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => auth(...args) }));
vi.mock('@/db', () => ({
    db: {
        query: { users: { findFirst } },
        select: () => ({ from: () => ({ where: selectWhere }) }),
        update: () => ({ set: (patch: unknown) => (updateSet(patch), { where: updateWhere }) }),
    },
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const { PATCH } = await import('./route');

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function patch(id: string, body: unknown) {
    const req = new NextRequest(`http://app.test/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return PATCH(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
    delete process.env.STACKRADAR_EDITION;
    delete process.env.AUTH_LOCAL_ENABLED;
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: ADMIN_ID, isAdmin: true, mustChangePassword: false } });
    findFirst.mockReset();
    findFirst.mockResolvedValue({ id: USER_ID, isAdmin: false, demo: false });
    selectWhere.mockReset();
    selectWhere.mockResolvedValue([{ n: 1 }]);
    updateSet.mockClear();
    updateWhere.mockClear();
});

describe('PATCH /api/admin/users/:id', () => {
    it('is gated like the rest of admin/users', async () => {
        auth.mockResolvedValueOnce(null);
        expect((await patch(USER_ID, { isAdmin: true })).status).toBe(401);
        auth.mockResolvedValueOnce({ user: { id: ADMIN_ID, isAdmin: false } });
        expect((await patch(USER_ID, { isAdmin: true })).status).toBe(403);
        process.env.STACKRADAR_EDITION = 'cloud';
        expect((await patch(USER_ID, { isAdmin: true })).status).toBe(404);
        expect(updateSet).not.toHaveBeenCalled();
    });

    it('grants the flag', async () => {
        const res = await patch(USER_ID, { isAdmin: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: USER_ID, isAdmin: true });
        expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    it('revokes the flag while another admin remains', async () => {
        findFirst.mockResolvedValue({ id: USER_ID, isAdmin: true, demo: false });
        const res = await patch(USER_ID, { isAdmin: false });
        expect(res.status).toBe(200);
        expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }));
    });

    it('refuses to revoke the last admin', async () => {
        findFirst.mockResolvedValue({ id: ADMIN_ID, isAdmin: true, demo: false });
        selectWhere.mockResolvedValue([{ n: 0 }]);
        const res = await patch(ADMIN_ID, { isAdmin: false });
        expect(res.status).toBe(409);
        expect((await res.json()).error).toContain('last platform admin');
        expect(updateSet).not.toHaveBeenCalled();
    });

    it('never grants the demo account, 400s a non-boolean, 404s an unknown id', async () => {
        findFirst.mockResolvedValueOnce({ id: USER_ID, isAdmin: false, demo: true });
        expect((await patch(USER_ID, { isAdmin: true })).status).toBe(403);
        expect((await patch(USER_ID, { isAdmin: 'yes' })).status).toBe(400);
        findFirst.mockResolvedValueOnce(undefined);
        expect((await patch(USER_ID, { isAdmin: true })).status).toBe(404);
        expect(updateSet).not.toHaveBeenCalled();
    });
});
