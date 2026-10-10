/**
 * OSV Download Utilities
 *
 * HTTP client with retry logic and streaming support.
 *
 * There is deliberately no conditional (ETag / If-Modified-Since) request here.
 * `modified_id.csv` does serve an ETag and `max-age=3600`, but the sync polls
 * hourly and the file has changed every time, so a 304 is a case that does not
 * arise; making it useful would also mean persisting the validator in
 * `osv_sync_state`. If the schedule ever goes sub-hourly, this is worth
 * revisiting.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import type { OsvSyncConfig } from "./config.js";
import { sleep, jitter as addJitter } from "../lib/http-retry.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:downloader");

/**
 * A response the server will keep giving us: 404, 403, 400 — anything 4xx that
 * is not 429. Retrying one costs four requests and several seconds of backoff
 * to arrive at the same answer, which on a burst day is multiplied by every
 * missing record in the batch.
 */
export class NonRetryableHttpError extends Error {
    public readonly status: number;

    constructor(url: string, status: number, statusText: string) {
        super(`HTTP ${status}: ${statusText}`);
        this.name = "NonRetryableHttpError";
        this.status = status;
        this.cause = url;
    }
}

export interface DownloadResult {
    data: Buffer;
    etag: string | undefined;
    lastModified: string | undefined;
    contentLength: number | undefined;
}

export interface OsvDownloader {
    /**
     * Download a file with retry logic
     */
    download(url: string): Promise<DownloadResult>;

    /**
     * Download multiple URLs in parallel with concurrency limit
     */
    downloadMany<T>(
        items: T[],
        urlFn: (item: T) => string,
        concurrency: number
    ): Promise<Map<T, DownloadResult | Error>>;

    /**
     * Stream download a large file (returns async iterator of chunks)
     */
    streamDownload(url: string): Promise<{
        body: ReadableStream<Uint8Array>;
        contentLength: number | undefined;
    }>;

    /**
     * Stream a text file line by line, never holding more than one line in
     * memory. Abandoning the iterator early (a `break`) tears the connection
     * down, so a caller that only wants the head of a sorted file pays for the
     * head of it.
     */
    streamLines(url: string): AsyncIterable<string>;

    /**
     * Compute SHA256 hash of data
     */
    computeSha256(data: Buffer): Buffer;
}

/**
 * Abort a streamed body when it goes quiet.
 *
 * The request timeout covers getting *a* response; it says nothing about a
 * connection that delivers headers and then stops. Each chunk re-arms the
 * timer, so a slow-but-progressing multi-GB download is left alone and a dead
 * one is killed in `stallMs` rather than in whatever `activeDeadlineSeconds`
 * the pod happens to carry.
 */
function withStallTimeout(
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
    stallMs: number,
    url: string
): ReadableStream<Uint8Array> {
    if (stallMs <= 0) return body;

    let timer: NodeJS.Timeout | undefined;

    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const arm = () => {
        clear();
        timer = setTimeout(() => {
            log.error({ url, stallMs }, "Download stalled — aborting");
            controller.abort(new Error(`Download stalled: no data for ${stallMs}ms`));
        }, stallMs);
        // Never a reason to hold the process open: if nothing else is running,
        // nobody is waiting on this body either.
        timer.unref?.();
    };

    arm();

    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, ctrl) {
                arm();
                ctrl.enqueue(chunk);
            },
            flush() {
                clear();
            },
        })
    );
}

/**
 * A live request. The timeout that covered the headers is still armed and still
 * belongs to this request's body — `cancelTimeout` is what ends it, and every
 * caller owes exactly one call once the body has been read, abandoned, or
 * handed to something else that owns the abort from there.
 */
interface FetchAttempt {
    response: Response;
    controller: AbortController;
    cancelTimeout: () => void;
}

export function createDownloader(config: OsvSyncConfig): OsvDownloader {
    const headers = {
        "User-Agent": config.userAgent,
    };

    async function fetchWithRetry(
        url: string,
        options: RequestInit = {},
        retries = config.maxRetries
    ): Promise<FetchAttempt> {
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            let timeoutId: NodeJS.Timeout | undefined = setTimeout(
                () => controller.abort(),
                config.requestTimeoutMs
            );
            const cancelTimeout = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
            };

            try {
                const response = await fetch(url, {
                    ...options,
                    headers: { ...headers, ...(options.headers as Record<string, string>) },
                    signal: controller.signal,
                });

                // Don't retry on 4xx errors (except 429). Thrown as its own type
                // so the catch below can tell it apart from a transport error and
                // re-throw instead of sleeping three times to reconfirm a 404.
                if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                    throw new NonRetryableHttpError(url, response.status, response.statusText);
                }

                // Retry on 429 or 5xx
                if (response.status === 429 || response.status >= 500) {
                    const retryAfter = response.headers.get("Retry-After");
                    const baseDelay = retryAfter
                        ? parseInt(retryAfter, 10) * 1000
                        : config.retryBaseDelayMs * Math.pow(2, attempt);
                    const delayMs = addJitter(baseDelay);

                    log.warn(
                        { url, status: response.status, attempt, delayMs },
                        "Request failed, retrying"
                    );

                    if (attempt < retries) {
                        cancelTimeout();
                        await sleep(delayMs);
                        continue;
                    }
                }

                // Deliberately still armed: the timer is handed to the caller
                // along with the unread body it now covers.
                return { response, controller, cancelTimeout };
            } catch (error) {
                cancelTimeout();

                if (error instanceof NonRetryableHttpError) {
                    throw error;
                }

                lastError = error instanceof Error ? error : new Error(String(error));

                if (attempt < retries) {
                    const baseDelay = config.retryBaseDelayMs * Math.pow(2, attempt);
                    const delayMs = addJitter(baseDelay);
                    log.warn(
                        { url, error: lastError.message, attempt, delayMs },
                        "Request error, retrying"
                    );
                    await sleep(delayMs);
                }
            }
        }

        throw lastError ?? new Error(`Failed to fetch ${url}`);
    }

    // Define methods as named functions so they can reference each other
    // without relying on fragile `this` binding.

    async function download(url: string): Promise<DownloadResult> {
        const { response, cancelTimeout } = await fetchWithRetry(url);

        // The timer is only cleared once the body has been read: a response whose
        // headers arrive and whose body then stalls used to hang indefinitely.
        try {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = Buffer.from(await response.arrayBuffer());

            return {
                data,
                etag: response.headers.get("ETag") ?? undefined,
                lastModified: response.headers.get("Last-Modified") ?? undefined,
                contentLength: data.length,
            };
        } finally {
            cancelTimeout();
        }
    }

    async function downloadMany<T>(
        items: T[],
        urlFn: (item: T) => string,
        concurrency: number
    ): Promise<Map<T, DownloadResult | Error>> {
        const results = new Map<T, DownloadResult | Error>();
        const queue = [...items];
        const inFlight = new Set<Promise<void>>();

        const processOne = async () => {
            const item = queue.shift();
            if (!item) return;

            try {
                const url = urlFn(item);
                const result = await download(url);
                results.set(item, result);
            } catch (error) {
                results.set(
                    item,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        };

        while (queue.length > 0 || inFlight.size > 0) {
            // Fill up to concurrency limit
            while (queue.length > 0 && inFlight.size < concurrency) {
                const promise = processOne().finally(() => {
                    inFlight.delete(promise);
                });
                inFlight.add(promise);
            }

            // Wait for at least one to complete
            if (inFlight.size > 0) {
                await Promise.race(inFlight);
            }
        }

        return results;
    }

    async function streamDownload(url: string): Promise<{
        body: ReadableStream<Uint8Array>;
        contentLength: number | undefined;
    }> {
        const { response, controller, cancelTimeout } = await fetchWithRetry(url);

        try {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error("Response body is null");
            }
        } catch (error) {
            cancelTimeout();
            throw error;
        }

        const contentLength = response.headers.get("Content-Length");

        // Hand-off: the fixed request timeout is retired and the stall detector
        // takes over the same AbortController for the life of the body. A
        // one-shot deadline cannot tell a 20-minute download from a dead socket.
        cancelTimeout();

        return {
            body: withStallTimeout(response.body, controller, config.streamStallTimeoutMs, url),
            contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
        };
    }

    async function* streamLines(url: string): AsyncGenerator<string> {
        const { body } = await streamDownload(url);
        const nodeStream = Readable.fromWeb(body as import("stream/web").ReadableStream);
        const lines = createInterface({ input: nodeStream, crlfDelay: Infinity });

        try {
            for await (const line of lines) {
                yield line;
            }
        } finally {
            // Reached on an early `break` too, which is the point: the caller
            // stops at the cutoff and the rest of the transfer is cancelled
            // rather than drained.
            lines.close();
            nodeStream.destroy();
        }
    }

    function computeSha256(data: Buffer): Buffer {
        return createHash("sha256").update(data).digest();
    }

    return {
        download,
        downloadMany,
        streamDownload,
        streamLines,
        computeSha256,
    };
}
