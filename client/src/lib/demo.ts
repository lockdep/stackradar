/**
 * The live demo.
 *
 * One image serves app.stackradar.io and demo.stackradar.io; `DEMO_MODE`
 * is the only thing that separates them. With it set, `/demo/enter` signs
 * anyone in as the demo user, the banner shows, and every control the
 * server would refuse (403 `read_only_demo`) is not drawn. With it
 * unset nothing in here is reachable — that is the property every caller
 * protects, because the unset case is production.
 *
 * `isDemoMode()` reads the environment on every call rather than at import:
 * it is checked in the auth config, the route gate and the layout, and a
 * value latched at first import would make the tests lie about the env.
 */
export function isDemoMode(): boolean {
    return process.env.DEMO_MODE === 'true';
}

/* Where the hosted demo lives and which account it signs visitors in as are
   the cloud's facts: `src/cloud/demo/hosted.ts`. The core keeps the switch,
   the session length and the refusal code, which the server's `read_only_demo`
   contract makes edition-neutral. */

/**
 * A demo session lives two hours from entry and never slides: a visitor is
 * a visitor, not an account, and the row is dropped by the sweep in
 * `/demo/enter` once it is a day past expiry.
 */
export const DEMO_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;

/** The `code` the server refuses demo-context mutations with (`server/src/lib/demo.ts`). */
export const READ_ONLY_DEMO_CODE = 'read_only_demo';

/**
 * The role the UI should draw controls for. The demo user *owns* the demo
 * org, but the server refuses every write on it, so drawing owner controls
 * would draw dead buttons; `member` is exactly the surface the server still
 * accepts. Every gate on `isAdminOrOwner` / `currentRole` inherits demo
 * read-only through this one substitution. Identity outside demo mode.
 */
export function viewerRole<T extends string | undefined>(role: T, demoMode: boolean): T | 'member' {
    return demoMode ? 'member' : role;
}
