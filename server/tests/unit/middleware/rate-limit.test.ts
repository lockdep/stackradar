/**
 * Per-key token buckets on the ingest surface (security review S8).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { rateLimitByApiKey } from "../../../src/middleware/rate-limit.js";
import { AppError } from "../../../src/middleware/error-handler.js";

function fakeReq(keyId: string | undefined): Request {
    return {
        auth: keyId
            ? { type: "api_key", apiKey: { id: keyId, name: "k", scopes: [] } }
            : { type: "internal", userId: "u1" },
    } as unknown as Request;
}

function fakeRes() {
    return { setHeader: vi.fn() } as unknown as Response;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("rateLimitByApiKey", () => {
    it("allows up to capacity, then 429s with Retry-After", () => {
        const mw = rateLimitByApiKey({ capacity: 3, refillPerMinute: 60, name: "test" });
        const res = fakeRes();
        const outcomes: unknown[] = [];
        for (let i = 0; i < 4; i++) {
            mw(fakeReq("key-1"), res, (err?: unknown) => outcomes.push(err));
        }
        expect(outcomes.slice(0, 3)).toEqual([undefined, undefined, undefined]);
        const err = outcomes[3] as AppError;
        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(429);
        expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    });

    it("refills over time", () => {
        vi.useFakeTimers();
        const mw = rateLimitByApiKey({ capacity: 1, refillPerMinute: 60, name: "test" });
        const res = fakeRes();
        const outcomes: unknown[] = [];
        mw(fakeReq("key-1"), res, (err?: unknown) => outcomes.push(err));
        mw(fakeReq("key-1"), res, (err?: unknown) => outcomes.push(err));
        expect(outcomes[0]).toBeUndefined();
        expect(outcomes[1]).toBeInstanceOf(AppError);

        vi.advanceTimersByTime(1_100); // one token refills in ~1s at 60/min
        mw(fakeReq("key-1"), res, (err?: unknown) => outcomes.push(err));
        expect(outcomes[2]).toBeUndefined();
    });

    it("buckets are per key", () => {
        const mw = rateLimitByApiKey({ capacity: 1, refillPerMinute: 1, name: "test" });
        const res = fakeRes();
        const outcomes: unknown[] = [];
        mw(fakeReq("key-1"), res, (err?: unknown) => outcomes.push(err));
        mw(fakeReq("key-2"), res, (err?: unknown) => outcomes.push(err));
        expect(outcomes).toEqual([undefined, undefined]);
    });

    it("passes internal (BFF) requests through untouched", () => {
        const mw = rateLimitByApiKey({ capacity: 0, refillPerMinute: 0, name: "test" });
        const outcomes: unknown[] = [];
        mw(fakeReq(undefined), fakeRes(), (err?: unknown) => outcomes.push(err));
        expect(outcomes).toEqual([undefined]);
    });
});
