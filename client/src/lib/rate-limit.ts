/**
 * A per-key token bucket, in memory. Enough for a single-replica route that
 * needs "not more than N a minute from one address"; not a substitute for
 * the ingress rate limit on anything that scales out.
 */
export class TokenBucket {
    private readonly buckets = new Map<string, { tokens: number; refilledAt: number }>();

    /**
     * @param capacity   burst size, also the steady-state rate per `perMs`
     * @param perMs      refill window: `capacity` tokens are returned per `perMs`
     * @param maxKeys    bound on tracked keys; full buckets are evicted first,
     *                   then the oldest, so one scanner cannot grow the map
     */
    constructor(
        private readonly capacity: number,
        private readonly perMs: number,
        private readonly maxKeys = 10_000,
    ) {}

    /** Take one token for `key`; false when the bucket is empty. */
    take(key: string, now = Date.now()): boolean {
        const bucket = this.buckets.get(key) ?? { tokens: this.capacity, refilledAt: now };
        const refill = ((now - bucket.refilledAt) / this.perMs) * this.capacity;
        bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
        bucket.refilledAt = now;
        if (bucket.tokens < 1) {
            this.buckets.set(key, bucket);
            return false;
        }
        bucket.tokens -= 1;
        this.buckets.delete(key); // re-insert so Map order is last-touched
        this.buckets.set(key, bucket);
        if (this.buckets.size > this.maxKeys) this.evict(now);
        return true;
    }

    private evict(now: number) {
        for (const [key, bucket] of this.buckets) {
            const refill = ((now - bucket.refilledAt) / this.perMs) * this.capacity;
            if (bucket.tokens + refill >= this.capacity) this.buckets.delete(key);
            if (this.buckets.size <= this.maxKeys / 2) return;
        }
        for (const key of this.buckets.keys()) {
            this.buckets.delete(key);
            if (this.buckets.size <= this.maxKeys / 2) return;
        }
    }
}
