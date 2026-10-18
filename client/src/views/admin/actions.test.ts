import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAdminAction } from './actions';

/**
 * The sentence an admin action's button shows for each thing the server
 * can answer, against a stubbed `fetch`. The three 409s are different
 * advice — wait, use kubectl, it is switched off — and must not collapse
 * into one "conflict".
 */
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );

describe('runAdminAction', () => {
    it('POSTs and describes a success from the body', async () => {
        answer(200, { retried: 3 });
        const out = await runAdminAction<{ retried: number }>(
            '/api/admin/jobs/retry-stuck',
            (b) => `${b.retried} retried`,
        );
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/jobs/retry-stuck');
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
        expect(out).toEqual({ ok: true, message: '3 retried' });
    });

    it('turns "already running" into advice to wait', async () => {
        answer(409, { error: 'epss is already running (started …)', code: 'in_progress' });
        const out = await runAdminAction('/api/admin/feeds/epss/sync', () => '');
        expect(out.ok).toBe(false);
        expect(out.message).toContain('Already running');
    });

    it('passes a topology or disabled refusal through — it names what to do', async () => {
        const msg = 'osv-sync cannot run from the API in the split topology; run the osv-sync CronJob instead';
        answer(409, { error: msg, code: 'not_available_in_split' });
        expect((await runAdminAction('/api/admin/osv/sync', () => '')).message).toBe(msg);
    });

    it('says when the server could not be reached, and names any other status', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));
        expect((await runAdminAction('/api/admin/rescan', () => '')).message).toBe('Could not reach the server.');

        answer(500, { error: 'boom' });
        expect((await runAdminAction('/api/admin/rescan', () => '')).message).toBe('The server answered 500: boom');
    });
});
