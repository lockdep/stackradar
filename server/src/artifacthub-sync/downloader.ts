/**
 * Fetching the Artifact Hub dump: HTTP with backoff, a byte ceiling, one parse.
 *
 * Buffered rather than streamed, on purpose. The dump is ~25 MB of JSON at
 * 02:15 on an otherwise idle worker, which fits the 512Mi pod limit with
 * margin — and unlike the EPSS CSV it is a single JSON array, so streaming
 * would mean a stream-json dependency for a file that comfortably fits in
 * memory. What guards the pod is the byte ceiling: a dump that outgrows
 * `maxBodyBytes` fails loudly here instead of OOMing the worker, and the
 * README documents stream-json as the escape hatch if that becomes routine.
 *
 * `file://` URLs are supported so the CLI can run against a locally
 * downloaded dump (`ARTIFACT_HUB_FEED_URL=file:///path/to/dump.json`).
 */

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ArtifactHubSyncConfig } from "./config.js";
import { fetchWithRetry } from "../lib/http-retry.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("artifacthub-sync:downloader");

/** Thrown when the body outgrows the configured ceiling — never retried. */
export class BodyTooLargeError extends Error {
    constructor(readonly limitBytes: number) {
        super(
            `Artifact Hub dump exceeds the ${limitBytes}-byte ceiling — refusing to buffer it. ` +
                `Raise ARTIFACT_HUB_MAX_BODY_BYTES, or move this module to a streaming parser (see README).`,
        );
        this.name = "BodyTooLargeError";
    }
}

export interface ArtifactHubDownloader {
    /** The parsed dump — expected to be a JSON array; the parser checks. */
    fetchDump(): Promise<unknown>;
}

export function createArtifactHubDownloader(config: ArtifactHubSyncConfig): ArtifactHubDownloader {
    /**
     * Read the body chunk-wise into a size-capped accumulator. The declared
     * `content-length` is checked first so an honestly-labelled oversize
     * response is refused before a byte arrives, but the accumulator is the
     * enforcement — chunked responses declare nothing.
     */
    async function readCappedBody(response: Response): Promise<string> {
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
            throw new BodyTooLargeError(config.maxBodyBytes);
        }
        if (!response.body) throw new Error("Artifact Hub response had no body");

        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                received += value.byteLength;
                if (received > config.maxBodyBytes) {
                    throw new BodyTooLargeError(config.maxBodyBytes);
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        const body = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(body);
    }

    async function readLocalFile(): Promise<string> {
        const path = fileURLToPath(config.feedUrl);
        const { size } = await stat(path);
        if (size > config.maxBodyBytes) throw new BodyTooLargeError(config.maxBodyBytes);
        return readFile(path, "utf-8");
    }

    return {
        async fetchDump(): Promise<unknown> {
            const text = config.feedUrl.startsWith("file://")
                ? await readLocalFile()
                : await readCappedBody(
                      await fetchWithRetry(config.feedUrl, {
                          label: "Artifact Hub",
                          log,
                          maxRetries: config.maxRetries,
                          retryBaseDelayMs: config.retryBaseDelayMs,
                          requestTimeoutMs: config.requestTimeoutMs,
                          headers: { "User-Agent": config.userAgent },
                      }),
                  );
            log.info({ bytes: text.length }, "Artifact Hub dump downloaded");
            return JSON.parse(text) as unknown;
        },
    };
}
