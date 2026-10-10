/**
 * HTTP fetch with exponential backoff, shared by the feed downloaders
 * (epss-sync, kev-sync, artifacthub-sync).
 *
 * `osv-sync/downloader.ts` deliberately keeps its own retry loop: it honours
 * `Retry-After`, hands a still-armed timeout to the caller along with the
 * unread body, and swaps in a stall detector for multi-GB streams — none of
 * which a single-file feed download needs.
 */

import type { Logger } from "pino";

/**
 * A 4xx other than 429 will say the same thing on the fourth attempt.
 * Retrying one costs more requests and several seconds of backoff to arrive
 * at the same answer, so it aborts the retry loop instead.
 */
export class NonRetryableHttpError extends Error {
    constructor(url: string, readonly status: number, statusText: string) {
        super(`HTTP ${status} ${statusText} for ${url}`);
        this.name = "NonRetryableHttpError";
    }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ±50% jitter, so a retry storm from several replicas does not stay in phase. */
export const jitter = (ms: number): number => Math.round(ms * (0.5 + Math.random()));

export interface FetchWithRetryOptions {
    /** Names the feed in log and error copy: "EPSS", "KEV", "Artifact Hub". */
    label: string;
    log: Logger;
    /** Retries after the first attempt; `maxRetries + 1` requests in total. */
    maxRetries: number;
    retryBaseDelayMs: number;
    requestTimeoutMs: number;
    headers: Record<string, string>;
    /**
     * Errors from `consume` that must abort the loop rather than be retried —
     * a body that downloaded fine but will not parse says the same thing on
     * the next attempt. Transport errors while reading the body stay
     * retryable, which is why `consume` runs inside the loop at all.
     */
    shouldRethrow?: (err: unknown) => boolean;
}

/**
 * Fetch `url`, retrying transport errors, 429 and 5xx with jittered
 * exponential backoff. Any other 4xx throws `NonRetryableHttpError`
 * immediately.
 *
 * Without `consume`, resolves with the `Response` and the caller owns the
 * body from there (its errors are then never retried). With `consume`, the
 * body is read inside the retry loop and its failures retry too, except
 * those `shouldRethrow` claims.
 */
export async function fetchWithRetry(url: string, options: FetchWithRetryOptions): Promise<Response>;
export async function fetchWithRetry<T>(
    url: string,
    options: FetchWithRetryOptions,
    consume: (response: Response) => Promise<T>
): Promise<T>;
export async function fetchWithRetry<T>(
    url: string,
    options: FetchWithRetryOptions,
    consume?: (response: Response) => Promise<T>
): Promise<T | Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = jitter(options.retryBaseDelayMs * 2 ** (attempt - 1));
            options.log.warn({ attempt, delay }, `Retrying ${options.label} download`);
            await sleep(delay);
        }

        try {
            const response = await fetch(url, {
                headers: options.headers,
                signal: AbortSignal.timeout(options.requestTimeoutMs),
            });

            if (response.ok) return consume ? await consume(response) : response;

            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                throw new NonRetryableHttpError(url, response.status, response.statusText);
            }
            lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        } catch (err) {
            if (err instanceof NonRetryableHttpError || options.shouldRethrow?.(err)) throw err;
            lastError = err;
        }
    }

    throw new Error(
        `${options.label} download failed after ${options.maxRetries + 1} attempts: ${String(lastError)}`
    );
}
