import { isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
    bootstrapAdminEmail,
    bootstrapAdminPassword,
    bootstrapAdminPasswordIsDefault,
    isLocalLoginEnabled,
} from "./local-login";
import { hashPassword } from "./password";
import { createLogger } from "./logger";

/**
 * The bootstrap admin (open-source plan step 04 §2): on start, when local
 * login is on and **no account has a password yet**, create `admin` with the
 * fixture password and `must_change_password` set. The server's default
 * organisation (step 03) makes whoever signs in first its owner, so this
 * account becomes the install's owner by being the first to log in.
 *
 * Idempotent and conservative: one local account anywhere means the install
 * has been bootstrapped and nothing is touched again, however the env vars
 * change later (the CLI `pnpm admin:reset-password` is the locked-out path).
 * An existing user at the address — someone who signed in with GitHub
 * first — is left alone too; a row we did not create is never modified.
 *
 * Two replicas starting together both see "no local account" and both
 * insert; the case-insensitive unique index on `users.email` lets exactly
 * one win and the other treats the violation as "already done".
 */

const log = createLogger("bootstrap-admin");

export type BootstrapOutcome = "disabled" | "already-bootstrapped" | "email-taken" | "created" | "raced";

export async function ensureBootstrapAdmin(): Promise<BootstrapOutcome> {
    if (!isLocalLoginEnabled()) return "disabled";

    const local = await db.query.users.findFirst({ columns: { id: true }, where: isNotNull(users.passwordHash) });
    if (local) return "already-bootstrapped";

    const email = bootstrapAdminEmail();
    const existing = await db.query.users.findFirst({
        columns: { id: true },
        where: sql`LOWER(${users.email}) = ${email.toLowerCase()}`,
    });
    if (existing) {
        log.warn({ email }, "bootstrap admin not created: a user with that address already exists and has no password; use `pnpm admin:reset-password` to give it one");
        return "email-taken";
    }

    const passwordHash = await hashPassword(bootstrapAdminPassword());
    try {
        await db.insert(users).values({
            email,
            name: "Administrator",
            emailVerified: new Date(),
            isAdmin: true,
            passwordHash,
            mustChangePassword: true,
        });
    } catch (err) {
        if (isUniqueViolation(err)) return "raced";
        throw err;
    }

    if (bootstrapAdminPasswordIsDefault()) {
        log.warn({ email }, "bootstrap admin created with the DEFAULT password; sign in and change it now (AUTH_BOOTSTRAP_ADMIN_PASSWORD sets a different one)");
    } else {
        log.info({ email }, "bootstrap admin created; the password must be changed on first sign-in");
    }
    return "created";
}

function isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}
