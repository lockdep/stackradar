/**
 * Password hashing for local sign-in: argon2id through
 * `@node-rs/argon2`, at the OWASP minimum (m=19 MiB, t=2, p=1). The PHC
 * string carries its own parameters, so these can be raised later and old
 * hashes still verify; a login that verifies against weaker parameters is
 * the place to rehash, if that ever matters.
 *
 * `verifyPassword` is the only comparison anyone may do, and
 * `verifyAgainstNothing` is what the failure paths that have no hash call —
 * unknown email, provider-only account, locked account — so that every
 * failed sign-in costs one argon2 verification, the same as a wrong
 * password. Skipping the work when there is nothing to compare against is
 * how an endpoint tells an attacker which emails exist.
 */

import { hash, verify } from '@node-rs/argon2';

// Argon2id is the library default (`Algorithm.Argon2id`); the const enum
// cannot be named under `isolatedModules`, so the test pins the `$argon2id$`
// prefix instead.
const PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
    return hash(password, PARAMS);
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
    try {
        return await verify(phc, password, PARAMS);
    } catch {
        // A malformed stored hash is a data problem, not a correct password.
        return false;
    }
}

/**
 * A real hash of a random secret, computed once per process; nothing ever
 * matches it. Computed lazily so importing this module costs nothing (the
 * build imports everything).
 */
let decoy: Promise<string> | null = null;

export async function verifyAgainstNothing(password: string): Promise<false> {
    decoy ??= hash(crypto.randomUUID(), PARAMS);
    await verify(await decoy, password, PARAMS).catch(() => false);
    return false;
}
