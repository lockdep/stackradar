/**
 * Cookie name used by the browser to indicate the active organization.
 * `OrganizationProvider` writes this when the user switches orgs; the BFF
 * validates it against the user's actual memberships before forwarding to
 * Express, so the cookie cannot be used to escalate into another org.
 *
 * Lives in its own module (not `api-utils`) so client components can import
 * it without dragging the server-only BFF utilities (pino, `next/server`)
 * into the client bundle.
 */
export const ACTIVE_ORG_COOKIE = "sr_org_id";

/** Rows per page wherever a table pages server-side (cluster tabs, admin tables). */
export const PAGE_SIZE = 50;

/** How long typing may rest before a server-side search actually fires. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The global search palette's debounce — shorter than the list pages':
 * results appear under the caret, so the eye is waiting on them.
 */
export const PALETTE_DEBOUNCE_MS = 200;
