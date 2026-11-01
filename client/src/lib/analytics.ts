/**
 * Product analytics, behind one function, so the SDK is a runtime choice.
 *
 * `posthog-js` loads only when `PostHogProvider` has a key: a community
 * build shipped the whole SDK in a shared client chunk (248 KB, the
 * largest static chunk of the 2026-10 build) for an `init` that never ran.
 * Every call site goes through `capture`, which is a no-op until the
 * provider has handed the loaded client over, and stays one in an install
 * with no key. The alternative — each caller importing `posthog-js` and
 * checking `__loaded` — is what put the SDK in every bundle.
 *
 * Never pass user content (a search query, a cluster name) as a property;
 * event names and enumerated sources only.
 */

type Captures = {
    capture: (event: string, properties?: Record<string, unknown>) => unknown;
    alias?: (alias: string) => unknown;
    reset?: () => unknown;
};

let client: Captures | null = null;

/** An org id whose alias was asked for before the SDK had loaded; sent when it does. */
let pendingAlias: string | null = null;

/** Called once by `PostHogProvider` after `init`; nothing else sets it. */
export function setAnalyticsClient(next: Captures | null): void {
    client = next;
    if (next && pendingAlias) {
        next.alias?.(pendingAlias);
        pendingAlias = null;
    }
}

/**
 * Fold the organisation a sign-up just created into this browser's PostHog
 * person, so the server-side funnel events keyed on the org id
 * (`signup_completed`, `first_sbom_received`, the plan transitions —
 * server `services/posthog.service.ts`) land on the person whose visit
 * led to the sign-up. PostHog's `alias` merges the org id, which nothing
 * has identified, into the current distinct id, which may be identified;
 * that direction is the one PostHog allows. Called once, from the setup
 * call that creates the org (`OrganizationProvider`); if the SDK has not
 * loaded yet the id is kept and sent the moment it does, so a slow network
 * cannot lose the join. The org id is not personal data; nothing else is
 * sent.
 */
export function aliasOrganization(orgId: string): void {
    if (client) client.alias?.(orgId);
    else pendingAlias = orgId;
}

/**
 * Forget the device's PostHog identity. Called before sign-out: with
 * cookie persistence the identified distinct id would otherwise survive
 * the session on this device and on every `.stackradar.io` subdomain, and
 * the next person to sign in here would be attributed to the previous
 * one until their own `identify` — which PostHog would then refuse to
 * merge, two identified ids being unmergeable.
 */
export function resetAnalytics(): void {
    client?.reset?.();
}

/** Record a product event. A no-op when analytics is not loaded. */
export function capture(event: string, properties?: Record<string, unknown>): void {
    client?.capture(event, properties);
}
