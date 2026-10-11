import { afterEach, describe, expect, it } from 'vitest';
import { EditionError, readEdition, resolveEdition } from './edition';

const original = process.env.STACKRADAR_EDITION;
afterEach(() => {
    if (original === undefined) delete process.env.STACKRADAR_EDITION;
    else process.env.STACKRADAR_EDITION = original;
});

describe('resolveEdition', () => {
    it('is the community edition when unset or empty', () => {
        for (const raw of [undefined, '', ' ']) {
            expect(resolveEdition(raw).edition).toBe('community');
        }
    });

    it("mirrors the server's two capability tables", () => {
        expect(resolveEdition('community')).toEqual({
            edition: 'community',
            isCloud: false,
            multiOrg: false,
            multiCluster: false,
            alerting: 'webhook',
            sso: 'oidc',
            billing: false,
            support: false,
        });
        expect(resolveEdition('cloud')).toEqual({
            edition: 'cloud',
            isCloud: true,
            multiOrg: true,
            multiCluster: true,
            alerting: 'full',
            sso: 'enterprise',
            billing: true,
            support: true,
        });
    });

    it('refuses anything else', () => {
        expect(() => resolveEdition('Cloud')).toThrow(EditionError);
    });
});

describe('readEdition', () => {
    it('reads the environment on every call', () => {
        process.env.STACKRADAR_EDITION = 'cloud';
        expect(readEdition().isCloud).toBe(true);
        delete process.env.STACKRADAR_EDITION;
        expect(readEdition().isCloud).toBe(false);
    });
});
