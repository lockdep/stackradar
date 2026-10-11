import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reloadIfSessionLost = vi.fn<() => Promise<boolean>>();
vi.mock('@/lib/session-lost', () => ({ reloadIfSessionLost: () => reloadIfSessionLost() }));

const { apiFetch, ApiError, errorMessage } = await import('./api-client');

const fetchMock = vi.fn<typeof fetch>();

function response(status: number, body?: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
}

/** Resolves to `'pending'` unless the promise settles first. */
async function settledOrPending<T>(p: Promise<T>): Promise<T | 'pending'> {
    return Promise.race([p, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20))]);
}

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    reloadIfSessionLost.mockReset();
    reloadIfSessionLost.mockResolvedValue(false);
});

afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
});

describe('apiFetch', () => {
    it('resolves to the parsed body of a 2xx', async () => {
        fetchMock.mockResolvedValue(response(200, { clusters: [{ id: 'c1' }] }));
        await expect(apiFetch<{ clusters: { id: string }[] }>('/api/clusters')).resolves.toEqual({
            clusters: [{ id: 'c1' }],
        });
        expect(fetchMock).toHaveBeenCalledWith('/api/clusters', {});
    });

    it('resolves to undefined for an empty 2xx', async () => {
        fetchMock.mockResolvedValue(response(204));
        await expect(apiFetch('/api/clusters/c1', { method: 'DELETE' })).resolves.toBeUndefined();
    });

    it('serialises `json` and sets the content type', async () => {
        fetchMock.mockResolvedValue(response(200, { ok: true }));
        await apiFetch('/api/organizations/o1', { method: 'PATCH', json: { name: 'Acme' } });
        const [, init] = fetchMock.mock.calls[0]!;
        expect(init?.method).toBe('PATCH');
        expect(init?.body).toBe('{"name":"Acme"}');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('throws an ApiError carrying the `{ error }` envelope of a non-2xx', async () => {
        fetchMock.mockResolvedValue(response(409, { error: 'Name already taken' }));
        const err = await apiFetch('/api/organizations', { method: 'POST', json: {} }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect((err as InstanceType<typeof ApiError>).status).toBe(409);
        expect((err as Error).message).toBe('Name already taken');
        expect((err as InstanceType<typeof ApiError>).body).toEqual({ error: 'Name already taken' });
    });

    it('falls back to the status when a failure has no envelope', async () => {
        fetchMock.mockResolvedValue(new Response('<html>', { status: 502 }));
        await expect(apiFetch('/api/clusters')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
    });

    it('on 401 checks the session and, when it is gone, never settles', async () => {
        reloadIfSessionLost.mockResolvedValue(true);
        fetchMock.mockResolvedValue(response(401, { error: 'Unauthorized' }));
        await expect(settledOrPending(apiFetch('/api/clusters'))).resolves.toBe('pending');
        expect(reloadIfSessionLost).toHaveBeenCalledTimes(1);
    });

    it('on 401 with the session still there, throws like any other failure', async () => {
        reloadIfSessionLost.mockResolvedValue(false);
        fetchMock.mockResolvedValue(response(401, { error: 'Unauthorized' }));
        await expect(apiFetch('/api/clusters')).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
    });

    it("`on401: 'throw'` surfaces a 401 without touching the session", async () => {
        fetchMock.mockResolvedValue(response(401, { error: 'Wrong password' }));
        await expect(apiFetch('/api/auth/local', { on401: 'throw' })).rejects.toMatchObject({
            status: 401,
            message: 'Wrong password',
        });
        expect(reloadIfSessionLost).not.toHaveBeenCalled();
    });

    it('wraps a network failure as a status-0 ApiError with the cause', async () => {
        const cause = new TypeError('Failed to fetch');
        fetchMock.mockRejectedValue(cause);
        const err = await apiFetch('/api/clusters').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect((err as InstanceType<typeof ApiError>).status).toBe(0);
        expect((err as Error).cause).toBe(cause);
    });

    it('lets an AbortError through untouched', async () => {
        const abort = new DOMException('The operation was aborted.', 'AbortError');
        fetchMock.mockRejectedValue(abort);
        await expect(apiFetch('/api/search?q=x')).rejects.toBe(abort);
    });
});

describe('errorMessage', () => {
    it('prefers the thrown message and falls back otherwise', () => {
        expect(errorMessage(new ApiError(500, 'Boom'), 'Failed')).toBe('Boom');
        expect(errorMessage(new Error(''), 'Failed')).toBe('Failed');
        expect(errorMessage('nope', 'Failed')).toBe('Failed');
    });
});
