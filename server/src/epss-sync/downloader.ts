/**
 * Fetching the EPSS snapshot: HTTP with backoff, gunzip, lines out.
 *
 * Streamed rather than buffered. The file is only ~15 MB uncompressed, so this
 * is not about memory — it is that the parser and the staging insert can start
 * on the first batch while the rest is still arriving, which is most of the
 * run's wall clock.
 */

import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import type { EpssSyncConfig } from "./config.js";
import { fetchWithRetry } from "../lib/http-retry.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("epss-sync:downloader");

export interface EpssDownloader {
    /** Lines of the decompressed CSV, in file order. */
    streamLines(): AsyncIterable<string>;
}

export function createEpssDownloader(config: EpssSyncConfig): EpssDownloader {
    return {
        async *streamLines(): AsyncIterable<string> {
            const response = await fetchWithRetry(config.feedUrl, {
                label: "EPSS",
                log,
                maxRetries: config.maxRetries,
                retryBaseDelayMs: config.retryBaseDelayMs,
                requestTimeoutMs: config.requestTimeoutMs,
                headers: { "User-Agent": config.userAgent },
            });
            if (!response.body) throw new Error("EPSS response had no body");

            // The gunzip stream is driven by its own pipeline rather than being
            // awaited here, so that consuming the readline interface applies
            // backpressure all the way to the socket. Awaiting the pipeline
            // first would buffer the whole file.
            const out = new PassThrough();
            const done = pipeline(
                Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
                createGunzip(),
                out,
            );

            try {
                for await (const line of createInterface({ input: out, crlfDelay: Infinity })) {
                    yield line;
                }
                await done;
            } finally {
                out.destroy();
            }
        },
    };
}
