#!/usr/bin/env node
/**
 * Reset a local account's password from the shell — the locked-out-admin
 * path for an install with no email.
 *
 *   pnpm admin:reset-password <email> [--password <new>]
 *
 * Without `--password` a random one is generated and printed once. Either
 * way the account must change it at its next sign-in, its lockout is
 * cleared, and every session it has is revoked. Only accounts that already
 * sign in with a password are touched unless `--create-local` is given,
 * which turns a provider-only account into one that also has a password —
 * say so explicitly, because it adds a way into someone's account.
 *
 * Plain Node with the two runtime dependencies (`postgres`, `@node-rs/argon2`)
 * so it runs inside the production image: `node scripts/admin-reset-password.mjs`.
 * Reads `DATABASE_URL` (and `DATABASE_CA_CERT`) like the app does; the
 * tables are the `auth` schema's.
 */

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { Algorithm, hash } from '@node-rs/argon2';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const passwordIndex = args.indexOf('--password');
const given = passwordIndex >= 0 ? args[passwordIndex + 1] : undefined;
const createLocal = args.includes('--create-local');

if (!email) {
    console.error('usage: pnpm admin:reset-password <email> [--password <new>] [--create-local]');
    process.exit(2);
}
if (given !== undefined && given.length < 12) {
    console.error('the password must be at least 12 characters');
    process.exit(2);
}

const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5444/server';
const sql = postgres(url, {
    max: 1,
    ...(process.env.DATABASE_CA_CERT ? { ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT } } : {}),
});

try {
    const [user] = await sql`SELECT id, password_hash FROM auth.users WHERE LOWER(email) = LOWER(${email})`;
    if (!user) {
        console.error(`no user with email ${email}`);
        process.exit(1);
    }
    if (!user.password_hash && !createLocal) {
        console.error(
            `${email} signs in through an identity provider and has no password; pass --create-local to give it one anyway`,
        );
        process.exit(1);
    }

    const password = given ?? randomBytes(15).toString('base64url');
    const phc = await hash(password, {
        algorithm: Algorithm.Argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
    });

    await sql.begin(async (tx) => {
        await tx`UPDATE auth.users SET password_hash = ${phc}, must_change_password = true, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = ${user.id}`;
        await tx`DELETE FROM auth.sessions WHERE user_id = ${user.id}`;
    });

    console.log(`password reset for ${email}; every session was revoked and the next sign-in must change it.`);
    if (given === undefined) console.log(`temporary password: ${password}`);
} finally {
    await sql.end();
}
