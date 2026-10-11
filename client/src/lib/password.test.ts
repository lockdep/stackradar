import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstNothing, verifyPassword } from './password';

describe('password hashing', () => {
    it('produces an argon2id PHC string that verifies, and only for the same password', async () => {
        const phc = await hashPassword('correct horse battery staple');
        expect(phc.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
        expect(await verifyPassword(phc, 'correct horse battery staple')).toBe(true);
        expect(await verifyPassword(phc, 'correct horse battery stapl')).toBe(false);
    });

    it('salts: two hashes of one password differ', async () => {
        const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
        expect(a).not.toBe(b);
    });

    it('treats a malformed stored hash as a wrong password rather than throwing', async () => {
        expect(await verifyPassword('not-a-phc-string', 'anything')).toBe(false);
        expect(await verifyPassword('', 'anything')).toBe(false);
    });

    it('verifyAgainstNothing is always false and costs a real verification', async () => {
        const started = performance.now();
        expect(await verifyAgainstNothing('whatever')).toBe(false);
        expect(await verifyAgainstNothing('')).toBe(false);
        // Two argon2 verifications at m=19 MiB are milliseconds, not microseconds.
        expect(performance.now() - started).toBeGreaterThan(1);
    });
});
