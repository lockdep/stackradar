import { afterEach, describe, expect, it } from 'vitest';
import { isDemoMode, viewerRole } from './demo';

const original = { DEMO_MODE: process.env.DEMO_MODE };

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('isDemoMode', () => {
    it('is false when unset', () => {
        delete process.env.DEMO_MODE;
        expect(isDemoMode()).toBe(false);
    });

    it.each(['', '1', 'yes', 'TRUE', 'True', 'false', ' true'])('is false for %j', (value) => {
        process.env.DEMO_MODE = value;
        expect(isDemoMode()).toBe(false);
    });

    it('is true only for the literal "true"', () => {
        process.env.DEMO_MODE = 'true';
        expect(isDemoMode()).toBe(true);
    });

    it('reads the environment on every call, not at import', () => {
        process.env.DEMO_MODE = 'true';
        expect(isDemoMode()).toBe(true);
        delete process.env.DEMO_MODE;
        expect(isDemoMode()).toBe(false);
    });
});

describe('viewerRole', () => {
    it('is the identity outside demo mode', () => {
        expect(viewerRole('owner', false)).toBe('owner');
        expect(viewerRole('admin', false)).toBe('admin');
        expect(viewerRole(undefined, false)).toBeUndefined();
    });

    it('draws member controls in demo mode whatever the real role', () => {
        expect(viewerRole('owner', true)).toBe('member');
        expect(viewerRole(undefined, true)).toBe('member');
    });
});
