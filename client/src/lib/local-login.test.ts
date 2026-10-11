import { afterEach, describe, expect, it } from 'vitest';
import {
    bootstrapAdminEmail,
    bootstrapAdminPassword,
    bootstrapAdminPasswordIsDefault,
    isLocalLoginEnabled,
    passwordPolicyProblem,
} from './local-login';

const KEYS = [
    'STACKRADAR_EDITION',
    'AUTH_LOCAL_ENABLED',
    'AUTH_BOOTSTRAP_ADMIN_EMAIL',
    'AUTH_BOOTSTRAP_ADMIN_PASSWORD',
] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
    for (const key of KEYS) {
        const value = values[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

afterEach(() => setEnv(original as Partial<Record<(typeof KEYS)[number], string>>));

describe('isLocalLoginEnabled', () => {
    it('is on by default in the community edition', () => {
        setEnv({});
        expect(isLocalLoginEnabled()).toBe(true);
        setEnv({ STACKRADAR_EDITION: 'community' });
        expect(isLocalLoginEnabled()).toBe(true);
    });

    it('is off by default in the cloud', () => {
        setEnv({ STACKRADAR_EDITION: 'cloud' });
        expect(isLocalLoginEnabled()).toBe(false);
    });

    it('AUTH_LOCAL_ENABLED overrides the edition either way', () => {
        setEnv({ STACKRADAR_EDITION: 'cloud', AUTH_LOCAL_ENABLED: 'true' });
        expect(isLocalLoginEnabled()).toBe(true);
        setEnv({ STACKRADAR_EDITION: 'community', AUTH_LOCAL_ENABLED: 'false' });
        expect(isLocalLoginEnabled()).toBe(false);
        // Anything that is not a boolean word is ignored, not read as "true".
        setEnv({ STACKRADAR_EDITION: 'cloud', AUTH_LOCAL_ENABLED: 'yes' });
        expect(isLocalLoginEnabled()).toBe(false);
    });
});

describe('bootstrap admin identity', () => {
    it('defaults to admin@stackradar.local with the fixture password', () => {
        setEnv({});
        expect(bootstrapAdminEmail()).toBe('admin@stackradar.local');
        expect(bootstrapAdminPassword()).toBe('admin');
        expect(bootstrapAdminPasswordIsDefault()).toBe(true);
    });

    it('takes both from the environment', () => {
        setEnv({
            AUTH_BOOTSTRAP_ADMIN_EMAIL: ' ops@example.com ',
            AUTH_BOOTSTRAP_ADMIN_PASSWORD: 'correct horse battery',
        });
        expect(bootstrapAdminEmail()).toBe('ops@example.com');
        expect(bootstrapAdminPassword()).toBe('correct horse battery');
        expect(bootstrapAdminPasswordIsDefault()).toBe(false);
    });
});

describe('passwordPolicyProblem', () => {
    it('is length only', () => {
        expect(passwordPolicyProblem('short')).toMatch(/at least 12/);
        expect(passwordPolicyProblem('twelve chars')).toBeNull();
        expect(passwordPolicyProblem('aaaaaaaaaaaa')).toBeNull(); // no composition rule
        expect(passwordPolicyProblem('x'.repeat(257))).toMatch(/at most 256/);
    });
});
