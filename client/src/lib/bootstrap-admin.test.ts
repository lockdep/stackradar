import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from './password';

const findFirst = vi.fn();
const insertValues = vi.fn<(row: Record<string, unknown>) => Promise<void>>(async () => undefined);
const warn = vi.fn();

vi.mock('@/db', () => ({
    db: {
        query: { users: { findFirst } },
        insert: () => ({ values: insertValues }),
    },
}));
vi.mock('./logger', () => ({ createLogger: () => ({ error: vi.fn(), warn, info: vi.fn() }) }));

const { ensureBootstrapAdmin } = await import('./bootstrap-admin');

const KEYS = [
    'STACKRADAR_EDITION',
    'AUTH_LOCAL_ENABLED',
    'AUTH_BOOTSTRAP_ADMIN_EMAIL',
    'AUTH_BOOTSTRAP_ADMIN_PASSWORD',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    findFirst.mockReset();
    insertValues.mockClear();
    warn.mockClear();
});
afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('ensureBootstrapAdmin', () => {
    it('does nothing when local login is off', async () => {
        process.env.STACKRADAR_EDITION = 'cloud';
        expect(await ensureBootstrapAdmin()).toBe('disabled');
        expect(findFirst).not.toHaveBeenCalled();
    });

    it('creates admin with the fixture password, as admin, forced to change it', async () => {
        findFirst.mockResolvedValue(undefined); // no local account, no row at the address
        expect(await ensureBootstrapAdmin()).toBe('created');

        expect(insertValues).toHaveBeenCalledTimes(1);
        const row = insertValues.mock.calls[0]![0];
        expect(row.email).toBe('admin@stackradar.local');
        expect(row.isAdmin).toBe(true);
        expect(row.mustChangePassword).toBe(true);
        expect(await verifyPassword(row.passwordHash as string, 'admin')).toBe(true);
        // The default password earns a warning in the log, every start.
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('takes the identity from the environment and does not warn for a chosen password', async () => {
        process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL = 'ops@example.com';
        process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD = 'chosen by the operator';
        findFirst.mockResolvedValue(undefined);
        expect(await ensureBootstrapAdmin()).toBe('created');
        const row = insertValues.mock.calls[0]![0];
        expect(row.email).toBe('ops@example.com');
        expect(await verifyPassword(row.passwordHash as string, 'chosen by the operator')).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it('is a no-op once any account has a password — the env may change, the row does not', async () => {
        findFirst.mockResolvedValueOnce({ id: 'someone' });
        expect(await ensureBootstrapAdmin()).toBe('already-bootstrapped');
        expect(insertValues).not.toHaveBeenCalled();
    });

    it('never touches an existing user at the address', async () => {
        findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'github-user' });
        expect(await ensureBootstrapAdmin()).toBe('email-taken');
        expect(insertValues).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('treats a unique violation as another replica having won the race', async () => {
        findFirst.mockResolvedValue(undefined);
        insertValues.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
        expect(await ensureBootstrapAdmin()).toBe('raced');
    });

    it('rethrows anything else (the database is down) so the caller can retry', async () => {
        findFirst.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(ensureBootstrapAdmin()).rejects.toThrow('ECONNREFUSED');
    });
});
