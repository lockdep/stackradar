/**
 * Per-API-key token buckets for the `/v1` ingest surface (security review S8).
 *
 * A valid scanner key is scoped to one cluster's ingest, but nothing stopped
 * it from POSTing 10 MB SBOMs or full inventory replacements in a tight loop
 * and monopolising the worker and the database. The buckets are in-memory
 * and per process, and production runs more than one API replica, so the
 * effective allowance is `limit × replicas` (~2× today), with jitter from
 * how the Service spreads a key's requests. Accepted: the goal is bounding
 * abuse, not enforcing a precise quota — N× a generous ceiling is still a
 * ceiling, and it can only be looser than configured, never tighter. If an
 * exact limit ever matters, move the bucket into Postgres (one atomic
 * UPDATE per request; see docs/self-hosting/helm.md § "Ingest rate limits and replicas"). Unauthenticated
 * flooding is the ingress `limit-rps` annotation's job, not this
 * middleware's: these buckets are keyed on the authenticated key id and
 * mounted after `requireAuth`.
 */

import type { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler.js";

interface Bucket {
    tokens: number;
    updatedAt: number;
}

/** Prune state for keys not seen in this long. */
const IDLE_EVICT_MS = 10 * 60 * 1000;

export interface RateLimitOptions {
    /** Bucket size — the burst a key may spend at once. */
    capacity: number;
    /** Sustained allowance, tokens per minute. */
    refillPerMinute: number;
    /** Names the limit in the 429 message. */
    name: string;
}

/**
 * Token-bucket limiter keyed on the authenticated API key. Requests that
 * are not API-key authenticated (the BFF path) pass through untouched —
 * their abuse ceiling is the session, not a machine credential.
 */
export function rateLimitByApiKey(options: RateLimitOptions) {
    const buckets = new Map<string, Bucket>();

    const take = (key: string, now: number): number | null => {
        // Lazy sweep: eviction piggybacks on traffic so an abandoned key's
        // bucket doesn't live forever. The map is small (one entry per
        // active key), so a full sweep is cheap.
        if (buckets.size > 1000) {
            for (const [k, b] of buckets) {
                if (now - b.updatedAt > IDLE_EVICT_MS) buckets.delete(k);
            }
        }

        const bucket = buckets.get(key) ?? { tokens: options.capacity, updatedAt: now };
        const elapsedMinutes = (now - bucket.updatedAt) / 60_000;
        bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedMinutes * options.refillPerMinute);
        bucket.updatedAt = now;

        if (bucket.tokens < 1) {
            buckets.set(key, bucket);
            // Seconds until one token exists again.
            return Math.ceil(((1 - bucket.tokens) / options.refillPerMinute) * 60);
        }

        bucket.tokens -= 1;
        buckets.set(key, bucket);
        return null;
    };

    return (req: Request, res: Response, next: NextFunction): void => {
        const keyId = req.auth?.apiKey?.id;
        if (!keyId) return next();

        const retryAfter = take(keyId, Date.now());
        if (retryAfter !== null) {
            res.setHeader("Retry-After", String(retryAfter));
            return next(new AppError(429, `Rate limit exceeded for ${options.name}. Retry after ${retryAfter}s.`));
        }

        next();
    };
}
