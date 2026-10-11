// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
/**
 * Ad-click attribution, carried from the login URL to `POST /users/setup`.
 * Cloud only: the parameters come from the hosted product's ad campaigns,
 * and a self-hosted install has no campaign to attribute a sign-up to, so
 * the two core call sites (the login page, the setup route) run this only
 * when `edition.isCloud`.
 *
 * The marketing site forwards the ad network's click id and the `utm_*`
 * parameters onto its login links (landing-page `lib/attribution.ts`). They
 * arrive here as query parameters on `/login`, but the account is created
 * only after an OAuth round trip through GitHub or Google, which drops the
 * query. So the sign-in server action writes them into a short-lived
 * `httpOnly` cookie, and the first dashboard load — the one that calls
 * setup — reads the cookie, forwards the values to the server and clears it.
 *
 * The cookie lives one hour: long enough to sign in, short enough that it
 * is a hop, not a tracker. It is first-party, unreadable by scripts, and
 * holds only what was already in the URL. The privacy policy lists it under
 * "Cookies" as `sr_attr`.
 *
 * Kept free of `next/headers` so both the server action and a unit test can
 * import it.
 */

export const ATTRIBUTION_COOKIE = 'sr_attr';

/** One hour, in seconds. */
export const ATTRIBUTION_COOKIE_MAX_AGE = 60 * 60;

/**
 * Query parameter → field. `rdt_cid` is Reddit's click id, the one value the
 * server reports back to the network; the `utm_*` five are ours.
 */
const PARAMS = {
    rdt_cid: 'clickId',
    utm_source: 'utmSource',
    utm_medium: 'utmMedium',
    utm_campaign: 'utmCampaign',
    utm_content: 'utmContent',
    utm_term: 'utmTerm',
} as const;

export type Attribution = Partial<Record<(typeof PARAMS)[keyof typeof PARAMS], string>>;

/** Server-side column width is 255; anything longer is not a real parameter. */
const MAX_VALUE_LENGTH = 255;

function clean(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return undefined;
    return trimmed;
}

/**
 * The attribution carried by a page's query parameters, or null when there
 * is none. Accepts the shape Next.js hands a page (`searchParams`, where a
 * repeated key is an array — the first value wins).
 */
export function attributionFromSearchParams(params: Record<string, string | string[] | undefined>): Attribution | null {
    const out: Attribution = {};
    for (const [param, field] of Object.entries(PARAMS)) {
        const raw = params[param];
        const value = clean(Array.isArray(raw) ? raw[0] : raw);
        if (value) out[field] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** Cookie value → attribution; null for anything that is not ours. */
export function parseAttributionCookie(value: string | undefined): Attribution | null {
    if (!value) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Attribution = {};
    for (const field of Object.values(PARAMS)) {
        const v = clean((parsed as Record<string, unknown>)[field]);
        if (v) out[field] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
}

export function serializeAttributionCookie(attribution: Attribution): string {
    return JSON.stringify(attribution);
}
