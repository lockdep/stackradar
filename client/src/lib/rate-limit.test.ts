import { describe, expect, it } from "vitest";
import { TokenBucket } from "./rate-limit";

describe("TokenBucket", () => {
    it("allows a burst of `capacity` then refuses", () => {
        const bucket = new TokenBucket(3, 60_000);
        expect([bucket.take("a", 0), bucket.take("a", 0), bucket.take("a", 0)]).toEqual([true, true, true]);
        expect(bucket.take("a", 0)).toBe(false);
        // another key has its own bucket
        expect(bucket.take("b", 0)).toBe(true);
    });

    it("refills at capacity per window", () => {
        const bucket = new TokenBucket(2, 60_000);
        bucket.take("a", 0);
        bucket.take("a", 0);
        expect(bucket.take("a", 29_000)).toBe(false);
        expect(bucket.take("a", 30_000)).toBe(true); // one token back after half a window
        expect(bucket.take("a", 30_000)).toBe(false);
    });

    it("bounds the number of tracked keys", () => {
        const bucket = new TokenBucket(1, 60_000, 4);
        for (let i = 0; i < 20; i++) bucket.take(`k${i}`, 0);
        expect((bucket as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(4);
    });
});
