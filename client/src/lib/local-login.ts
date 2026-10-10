/**
 * Local username/password sign-in — docs/open-source-plan-2026-10-10.md
 * step 04. Whether it is on, and the bootstrap admin's identity; nothing
 * here touches the database (that is `lib/bootstrap-admin.ts`) or a
 * password (`lib/password.ts`).
 *
 * On by default in the community edition — every self-hosted tool this
 * audience runs has a local admin — and off by default in the cloud, where
 * `edition.sso` is `enterprise` and the sign-in is OAuth. `AUTH_LOCAL_ENABLED`
 * overrides either way: `false` lets an OIDC-only shop hide the form once
 * their IdP works; `true` is the cloud's escape hatch, which nothing sets.
 *
 * Read on every call rather than latched: like `isDemoMode()`, it is checked
 * in the auth config, the route gate and the layout, and the tests set the
 * environment per case.
 */

import { readEdition } from "./edition";

export const LOCAL_LOGIN_ENV = "AUTH_LOCAL_ENABLED";

export function isLocalLoginEnabled(): boolean {
    const raw = process.env[LOCAL_LOGIN_ENV]?.trim().toLowerCase();
    if (raw === "true") return true;
    if (raw === "false") return false;
    return !readEdition().isCloud;
}

/**
 * The bootstrap admin (`lib/bootstrap-admin.ts`): the account a bare install
 * signs in as. `admin@stackradar.local` is not a deliverable address on
 * purpose — nothing in the community edition sends mail, and `.local` is
 * reserved (RFC 6762) so it can never be claimed through an IdP either.
 */
export function bootstrapAdminEmail(): string {
    return process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL?.trim() || "admin@stackradar.local";
}

/**
 * The fixture password, Dependency-Track's `admin/admin` shape. It is only
 * ever stored with `must_change_password = true`, so the first thing the
 * fixture buys is the page that replaces it. The chart and Compose files
 * set this explicitly; the default here is for the bare `pnpm dev`.
 */
export function bootstrapAdminPassword(): string {
    return process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD || "admin";
}

export function bootstrapAdminPasswordIsDefault(): boolean {
    return !process.env.AUTH_BOOTSTRAP_ADMIN_PASSWORD;
}

/** Failures before a lock, and how long the lock holds. Step 04 §3. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * A local session's lifetime at issue. Auth.js then treats it like any
 * other database session: the 24-hour window in `auth.ts` slides on use.
 */
export const LOCAL_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/** The one message every failed sign-in gets, so none of them tells an attacker which part was wrong. */
export const SIGN_IN_FAILED_MESSAGE = "Invalid email or password, or the account is temporarily locked.";

/**
 * Password policy for anything set through the UI, the admin routes or the
 * CLI. Length only: composition rules push people to predictable
 * substitutions, and length is what argon2 cannot make up for. The bootstrap
 * fixture is exempt because it is never *set* by anyone — it is replaced.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export function passwordPolicyProblem(password: string): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
    return null;
}
