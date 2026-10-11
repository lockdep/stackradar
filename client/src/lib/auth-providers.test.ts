import { afterEach, describe, expect, it } from 'vitest';
import {
    authProviderProblems,
    enabledProviders,
    isProviderEnabled,
    oidcAdminFromProfile,
    oidcDisplayName,
} from './auth-providers';

const KEYS = [
    'DEMO_MODE',
    'STACKRADAR_EDITION',
    'AUTH_LOCAL_ENABLED',
    'AUTH_GITHUB_ID',
    'AUTH_GITHUB_SECRET',
    'AUTH_GOOGLE_ID',
    'AUTH_GOOGLE_SECRET',
    'AUTH_OIDC_ISSUER',
    'AUTH_OIDC_ID',
    'AUTH_OIDC_SECRET',
    'AUTH_OIDC_NAME',
    'AUTH_OIDC_ADMIN_GROUP',
    'AUTH_OIDC_GROUPS_CLAIM',
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

describe('authProviderProblems', () => {
    it('is healthy with one fully configured provider', () => {
        setEnv({ AUTH_LOCAL_ENABLED: 'false', AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret' });
        expect(enabledProviders()).toEqual(['github']);
        expect(authProviderProblems()).toEqual([]);
    });

    it('refuses a deployment with no sign-in method at all', () => {
        setEnv({ AUTH_LOCAL_ENABLED: 'false' });
        expect(authProviderProblems()).toEqual([
            'no sign-in method is configured (set AUTH_LOCAL_ENABLED=true, or AUTH_OIDC_* / AUTH_GITHUB_* / AUTH_GOOGLE_*)',
        ]);
    });

    it('counts local login as a sign-in method — the community default needs no provider', () => {
        setEnv({});
        expect(enabledProviders()).toEqual([]);
        expect(authProviderProblems()).toEqual([]);
        // …and in the cloud, where local login is off by default, zero providers is still a fault.
        setEnv({ STACKRADAR_EDITION: 'cloud' });
        expect(authProviderProblems()).toHaveLength(1);
    });

    it('accepts no provider at all in demo mode — /demo/enter is the sign-in', () => {
        setEnv({ DEMO_MODE: 'true', AUTH_LOCAL_ENABLED: 'false' });
        expect(enabledProviders()).toEqual([]);
        expect(authProviderProblems()).toEqual([]);
    });

    it('still reports a half-configured pair in every mode', () => {
        setEnv({ DEMO_MODE: 'true', AUTH_GITHUB_ID: 'id' });
        expect(authProviderProblems()).toEqual([
            'AUTH_GITHUB_ID / AUTH_GITHUB_SECRET: only AUTH_GITHUB_ID set (github is half-configured; missing AUTH_GITHUB_SECRET)',
        ]);
    });

    it('treats the OIDC triple as one provider: all three or a fault', () => {
        setEnv({ AUTH_OIDC_ISSUER: 'https://idp.example.com/realms/x', AUTH_OIDC_ID: 'stackradar' });
        expect(isProviderEnabled('oidc')).toBe(false);
        expect(authProviderProblems()[0]).toMatch(/oidc is half-configured; missing AUTH_OIDC_SECRET/);

        setEnv({
            AUTH_OIDC_ISSUER: 'https://idp.example.com/realms/x',
            AUTH_OIDC_ID: 'stackradar',
            AUTH_OIDC_SECRET: 's',
        });
        expect(enabledProviders()).toEqual(['oidc']);
        expect(authProviderProblems()).toEqual([]);
    });
});

describe('oidcDisplayName', () => {
    it('is the configured name or a generic label', () => {
        setEnv({});
        expect(oidcDisplayName()).toBe('Single sign-on');
        setEnv({ AUTH_OIDC_NAME: ' Keycloak ' });
        expect(oidcDisplayName()).toBe('Keycloak');
    });
});

describe('oidcAdminFromProfile', () => {
    it('is undefined — leave the column alone — when no admin group is configured', () => {
        setEnv({});
        expect(oidcAdminFromProfile({ groups: ['stackradar-admins'] })).toBeUndefined();
    });

    it('maps membership of the configured group, from an array or a single string', () => {
        setEnv({ AUTH_OIDC_ADMIN_GROUP: 'stackradar-admins' });
        expect(oidcAdminFromProfile({ groups: ['devs', 'stackradar-admins'] })).toBe(true);
        expect(oidcAdminFromProfile({ groups: 'stackradar-admins' })).toBe(true);
        expect(oidcAdminFromProfile({ groups: ['devs'] })).toBe(false);
        expect(oidcAdminFromProfile({})).toBe(false);
        expect(oidcAdminFromProfile({ groups: [{ name: 'stackradar-admins' }] })).toBe(false);
    });

    it('reads a differently named claim when told to', () => {
        setEnv({ AUTH_OIDC_ADMIN_GROUP: 'admins', AUTH_OIDC_GROUPS_CLAIM: 'roles' });
        expect(oidcAdminFromProfile({ roles: ['admins'], groups: [] })).toBe(true);
        expect(oidcAdminFromProfile({ groups: ['admins'] })).toBe(false);
    });
});
