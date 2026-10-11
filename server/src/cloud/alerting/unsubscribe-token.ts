// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config/index.js";

/**
 * The unsubscribe links in the weekly digest and the critical & KEV alert
 * carry a signed token rather than a session: they are clicked from a mail
 * client, possibly on a phone that has never signed in, and Gmail's
 * one-click unsubscribe POSTs them with no cookies at all. The token is
 * `<orgId>.<HMAC-SHA256(kind:orgId)>`, base64url, keyed by
 * `DIGEST_UNSUBSCRIBE_SECRET` (or the internal service key). It grants
 * exactly one thing — switching one org's one email kind off — so it
 * carries no expiry: a stale link that still works is the behaviour a
 * reader expects of an unsubscribe. The kind is in the signature, so a
 * digest token cannot switch the alerts off or the other way round.
 */

export type UnsubscribeKind = "digest" | "alerts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sign(kind: UnsubscribeKind, orgId: string, secret: string): string {
    return createHmac("sha256", secret).update(`${kind}-unsubscribe:${orgId}`).digest("base64url");
}

export function signUnsubscribeToken(
    kind: UnsubscribeKind,
    orgId: string,
    secret: string = config.email.digestUnsubscribeSecret,
): string {
    if (!secret) throw new Error("No unsubscribe secret configured");
    return `${orgId}.${sign(kind, orgId, secret)}`;
}

/** The org the token names, or null for anything malformed, mis-signed or of the other kind. */
export function verifyUnsubscribeToken(
    kind: UnsubscribeKind,
    token: string,
    secret: string = config.email.digestUnsubscribeSecret,
): string | null {
    if (!secret) return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const orgId = token.slice(0, dot);
    const given = token.slice(dot + 1);
    if (!UUID.test(orgId) || !given) return null;
    const expected = Buffer.from(sign(kind, orgId, secret));
    const candidate = Buffer.from(given);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null;
    return orgId.toLowerCase();
}

/**
 * The link. On the public API (`/v1`), not the client: the BFF would demand
 * a session, and an unsubscribe must work with none. `PUBLIC_API_URL` must
 * be the browser-reachable API host (api.stackradar.io in production) and
 * the ingress must expose both `/v1/digest/unsubscribe` and
 * `/v1/alerts/unsubscribe`, or every mail carries a dead link.
 */
export function unsubscribeUrl(kind: UnsubscribeKind, orgId: string): string {
    return `${config.publicApiUrl}/v1/${kind}/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(kind, orgId))}`;
}

/**
 * RFC 8058 one-click unsubscribe headers for a notification email. Gmail and
 * Yahoo look for these before deciding whether to offer their own
 * "Unsubscribe" button — and, for senders over their volume threshold,
 * before accepting the mail at all. The POST target is the same link; the
 * controller accepts GET (the footer link) and POST (the button) alike.
 */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
    return {
        "List-Unsubscribe": `<${url}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
}
