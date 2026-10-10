// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verification for Resend webhooks, which are delivered by Svix. The
 * signature scheme is documented at https://docs.svix.com/receiving/verifying-payloads/how-manual
 * — HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` with the
 * base64 secret after the `whsec_` prefix; the `svix-signature` header may
 * carry several space-separated `v1,<base64>` values (during secret rotation).
 *
 * Implemented by hand rather than via the `svix` package: it is ~30 lines and
 * keeps the server free of a dependency whose only job is this.
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
}

export type VerifyResult =
    | { ok: true }
    | { ok: false; reason: "missing_headers" | "bad_timestamp" | "timestamp_out_of_tolerance" | "no_signature_match" };

export function signResendPayload(secret: string, id: string, timestamp: string, body: string): string {
    const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
    return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export function verifyResendWebhook(
    secret: string,
    headers: SvixHeaders,
    rawBody: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
    if (!headers.id || !headers.timestamp || !headers.signature) {
        return { ok: false, reason: "missing_headers" };
    }

    const ts = Number(headers.timestamp);
    if (!Number.isInteger(ts)) {
        return { ok: false, reason: "bad_timestamp" };
    }
    if (Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) {
        return { ok: false, reason: "timestamp_out_of_tolerance" };
    }

    const expected = Buffer.from(signResendPayload(secret, headers.id, headers.timestamp, rawBody));
    for (const entry of headers.signature.split(" ")) {
        const [version, sig] = entry.split(",", 2);
        if (version !== "v1" || !sig) continue;
        const candidate = Buffer.from(sig);
        if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
            return { ok: true };
        }
    }
    return { ok: false, reason: "no_signature_match" };
}
