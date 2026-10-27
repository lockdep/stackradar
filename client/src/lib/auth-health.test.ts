import { beforeEach, describe, expect, it, vi } from 'vitest';

// The latch is module state, so each test gets a fresh copy of the module.
async function freshModule() {
    vi.resetModules();
    return import('./auth-health');
}

function authError(type: string, message: string): Error {
    return Object.assign(new Error(message), { type });
}

describe('recordAuthError', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('latches a configuration error', async () => {
        const { recordAuthError, getAuthConfigProblems } = await freshModule();
        const before = getAuthConfigProblems();

        recordAuthError(authError('MissingSecret', 'Please define a `secret`'));

        expect(getAuthConfigProblems()).toEqual([...before, 'MissingSecret: Please define a `secret`']);
    });

    // A GET to /api/auth/callback with no provider raises InvalidProvider.
    // Latching it let one anonymous request take every pod out of the Service.
    it.each(['InvalidProvider', 'UntrustedHost', 'AdapterError', 'CallbackRouteError'])(
        'ignores %s, which a request can trigger',
        async (type) => {
            const { recordAuthError, getAuthConfigProblems } = await freshModule();
            const before = getAuthConfigProblems();

            recordAuthError(authError(type, 'triggered by a request'));

            expect(getAuthConfigProblems()).toEqual(before);
        },
    );
});
