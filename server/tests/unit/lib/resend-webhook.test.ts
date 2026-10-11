import { describe, it, expect } from "vitest";
import {
    signResendPayload,
    verifyResendWebhook,
    WEBHOOK_TOLERANCE_SECONDS,
} from "../../../src/cloud/email/resend-webhook.js";

const SECRET = "whsec_" + Buffer.from("super-secret-key").toString("base64");
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "abc" } });
const NOW = 1_800_000_000;

function headers(overrides: Partial<{ id: string; timestamp: string; signature: string }> = {}) {
    const id = overrides.id ?? "msg_123";
    const timestamp = overrides.timestamp ?? String(NOW);
    const signature = overrides.signature ?? `v1,${signResendPayload(SECRET, id, timestamp, BODY)}`;
    return { id, timestamp, signature };
}

describe("verifyResendWebhook", () => {
    it("accepts a correctly signed payload", () => {
        expect(verifyResendWebhook(SECRET, headers(), BODY, NOW)).toEqual({ ok: true });
    });

    it("accepts when one of several rotated signatures matches", () => {
        const good = signResendPayload(SECRET, "msg_123", String(NOW), BODY);
        const h = headers({ signature: `v1,AAAA v1,${good}` });
        expect(verifyResendWebhook(SECRET, h, BODY, NOW)).toEqual({ ok: true });
    });

    it("rejects a tampered body", () => {
        expect(verifyResendWebhook(SECRET, headers(), BODY + " ", NOW)).toEqual({
            ok: false,
            reason: "no_signature_match",
        });
    });

    it("rejects the wrong secret", () => {
        const other = "whsec_" + Buffer.from("other").toString("base64");
        expect(verifyResendWebhook(other, headers(), BODY, NOW)).toEqual({ ok: false, reason: "no_signature_match" });
    });

    it("rejects missing headers", () => {
        expect(verifyResendWebhook(SECRET, { id: undefined, timestamp: "1", signature: "v1,x" }, BODY, NOW)).toEqual({
            ok: false,
            reason: "missing_headers",
        });
    });

    it("rejects a non-integer timestamp", () => {
        expect(verifyResendWebhook(SECRET, headers({ timestamp: "soon" }), BODY, NOW)).toEqual({
            ok: false,
            reason: "bad_timestamp",
        });
    });

    it("rejects a stale timestamp (replay)", () => {
        const stale = String(NOW - WEBHOOK_TOLERANCE_SECONDS - 1);
        expect(verifyResendWebhook(SECRET, headers({ timestamp: stale }), BODY, NOW)).toEqual({
            ok: false,
            reason: "timestamp_out_of_tolerance",
        });
    });

    it("ignores signature entries with unknown versions", () => {
        const good = signResendPayload(SECRET, "msg_123", String(NOW), BODY);
        expect(verifyResendWebhook(SECRET, headers({ signature: `v2,${good}` }), BODY, NOW)).toEqual({
            ok: false,
            reason: "no_signature_match",
        });
    });
});
