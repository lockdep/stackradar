/**
 * User-controlled text in internal headers must round-trip non-Latin-1
 * characters. Prod incident 2026-08-26: a user with an Arabic display name
 * got a 500 on every BFF call because `new Headers()` rejects code points
 * above U+00FF. The BFF now percent-encodes name/email/org-name and the
 * server decodes them here.
 */

import { describe, it, expect } from "vitest";
import { decodeHeaderValue, requireAuth } from "../../../src/middleware/auth.js";
import type { Request, Response } from "express";

process.env.INTERNAL_SERVICE_KEY ??= "test-internal-key-12345";

describe("decodeHeaderValue", () => {
    it("decodes percent-encoded Arabic text", () => {
        expect(decodeHeaderValue(encodeURIComponent("دانيال"))).toBe("دانيال");
        expect(decodeHeaderValue(encodeURIComponent("هدى محمد"))).toBe("هدى محمد");
    });

    it("decodes emoji and CJK", () => {
        expect(decodeHeaderValue(encodeURIComponent("🐙 山田"))).toBe("🐙 山田");
    });

    it("passes plain ASCII through unchanged", () => {
        expect(decodeHeaderValue("Jane Doe")).toBe("Jane Doe");
        expect(decodeHeaderValue("me@example.com")).toBe("me@example.com");
    });

    it("falls back to the raw value on malformed encoding (older clients)", () => {
        expect(decodeHeaderValue("100% legit")).toBe("100% legit");
    });

    it("handles undefined and array headers", () => {
        expect(decodeHeaderValue(undefined)).toBeUndefined();
        expect(decodeHeaderValue(["a%20b", "c"])).toBe("a b");
    });
});

describe("requireAuth internal context with encoded headers", () => {
    it("exposes decoded user and org names on req.auth", () => {
        const req = {
            // A read: the demo guard in `requireAuth` consults `users.demo`
            // only on mutations, which keeps this test header-only and
            // synchronous.
            method: "GET",
            headers: {
                "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
                "x-user-id": "u1",
                "x-user-email": encodeURIComponent("هدى@example.com"),
                "x-user-name": encodeURIComponent("هدى محمد"),
                "x-org-id": "o1",
                "x-org-name": encodeURIComponent("شركة الأمن"),
                "x-org-slug": "amn",
                "x-org-plan": "free",
            },
        } as unknown as Request;
        let err: unknown;
        requireAuth(req, {} as Response, (e?: unknown) => {
            err = e;
        });
        expect(err).toBeUndefined();
        expect(req.auth?.type).toBe("internal");
        expect(req.auth?.user?.name).toBe("هدى محمد");
        expect(req.auth?.user?.email).toBe("هدى@example.com");
        expect(req.auth?.org.name).toBe("شركة الأمن");
    });
});
