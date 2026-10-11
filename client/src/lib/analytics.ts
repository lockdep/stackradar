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

type Captures = { capture: (event: string, properties?: Record<string, unknown>) => unknown };

let client: Captures | null = null;

/** Called once by `PostHogProvider` after `init`; nothing else sets it. */
export function setAnalyticsClient(next: Captures | null): void {
    client = next;
}

/** Record a product event. A no-op when analytics is not loaded. */
export function capture(event: string, properties?: Record<string, unknown>): void {
    client?.capture(event, properties);
}
