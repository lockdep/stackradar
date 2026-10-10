/**
 * The live demo — `docs/live-demo/` step 02.
 *
 * One image serves app.stackradar.io and demo.stackradar.io; `DEMO_MODE`
 * is the only thing that separates them. With it set, `/demo/enter` signs
 * anyone in as the demo user, the banner shows, and every control the
 * server would refuse (403 `read_only_demo`, step 01) is not drawn. With it
 * unset nothing in here is reachable — that is the property every caller
 * protects, because the unset case is production.
 *
 * `isDemoMode()` reads the environment on every call rather than at import:
 * it is checked in the auth config, the route gate and the layout, and a
 * value latched at first import would make the tests lie about the env.
 */
export function isDemoMode(): boolean {
    return process.env.DEMO_MODE === "true";
}

/**
 * Where the demo lives, for the pages of the real app that offer it (the
 * login page). `/demo/enter` rather than the bare host: the host only
 * redirects there, and the direct link lands the visitor signed in.
 * Mirrors `DEMO_URL` in the landing page's `src/lib/site.ts`.
 */
export const DEMO_URL = "https://demo.stackradar.io/demo/enter";

/** The user `/demo/enter` signs visitors in as. The seed (server step 01) creates it. */
export function demoUserEmail(): string {
    return process.env.DEMO_USER_EMAIL?.trim() || "demo@stackradar.io";
}

/**
 * A demo session lives two hours from entry and never slides: a visitor is
 * a visitor, not an account, and the row is dropped by the sweep in
 * `/demo/enter` once it is a day past expiry.
 */
export const DEMO_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;

/** The `code` the server refuses demo-context mutations with (`server/src/lib/demo.ts`). */
export const READ_ONLY_DEMO_CODE = "read_only_demo";

/**
 * The role the UI should draw controls for. The demo user *owns* the demo
 * org, but the server refuses every write on it, so drawing owner controls
 * would draw dead buttons; `member` is exactly the surface the server still
 * accepts. Every gate on `isAdminOrOwner` / `currentRole` inherits demo
 * read-only through this one substitution. Identity outside demo mode.
 */
export function viewerRole<T extends string | undefined>(role: T, demoMode: boolean): T | "member" {
    return demoMode ? "member" : role;
}
