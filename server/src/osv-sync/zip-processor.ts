/**
 * ZIP Processor for OSV all.zip
 *
 * Processes the OSV all.zip file in a streaming fashion without extracting
 * the entire archive to disk. Uses the yauzl library for ZIP parsing.
 */

import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import type { OsvDownloader } from "./downloader.js";
import type { ParsedOsvRecord } from "./parser.js";
import { parseOsvJson, extractEcosystemDir } from "./parser.js";

const log = createLogger("osv-sync:zip-processor");

export interface ZipEntryInfo {
    path: string;
    ecosystemDir: string;
    vulnId: string;
}

export interface ZipProcessFailure {
    sourcePath: string;
    ecosystemDir: string | null;
    osvId: string | null;
    errorType: "parse_error";
    errorMessage: string;
}

export interface ZipProcessorResult {
    processedCount: number;
    /** Entries that could not be read or parsed. Tolerated, and never a write failure. */
    errorCount: number;
    maxModifiedTimestamp: Date | null;
    errors: string[];
}

/**
 * Thrown when the `onRecord` callback fails — that is, when the *consumer*
 * (in practice, the database write) failed rather than the OSV data.
 *
 * These two failure classes must not be conflated. A malformed record is a fact
 * about OSV's data: skipping it costs one advisory and the run is still worth
 * finishing. A failed write is a fact about us: continuing would drop every
 * record in the batch, and since a bootstrap only ever visits records once, the
 * hole would never be backfilled — incremental sync revisits nothing below the
 * watermark. So a write failure aborts the whole run and leaves the mirror
 * uninitialized, which is loud, rather than a silent five-figure gap.
 */
export class ZipRecordConsumerError extends Error {
    public readonly entryPath: string;

    constructor(entryPath: string, cause: unknown) {
        super(
            `Record consumer failed on ${entryPath}: ${cause instanceof Error ? cause.message : String(cause)}`
        );
        this.name = "ZipRecordConsumerError";
        this.entryPath = entryPath;
        this.cause = cause;
    }
}

export interface ZipProcessOptions {
    batchSize?: number;
    onProgress?: (processed: number, total?: number) => void;
    onError?: (failure: ZipProcessFailure) => void;
    /**
     * Decide whether an entry is worth reading, from its path alone. Applied
     * before the entry is decompressed, so a caller that wants 40 records out
     * of an ecosystem archive pays for 40 inflations rather than all of them.
     * Filtered entries are neither processed nor counted as errors.
     */
    filter?: (entry: ZipEntryInfo) => boolean;
}

export interface ZipProcessor {
    /**
     * Download a ZIP archive to a temp file and stream its entries.
     *
     * Serves both OSV archives: `all.zip` for a full rebuild, and the
     * per-ecosystem `<Ecosystem>/all.zip` archives that an incremental sync
     * falls back to when a burst day makes per-record GETs the wrong shape of
     * work.
     */
    processZip(
        url: string,
        onRecord: (record: ParsedOsvRecord, entry: ZipEntryInfo) => Promise<void>,
        options?: ZipProcessOptions
    ): Promise<ZipProcessorResult>;
}

/**
 * Parse entry path from ZIP to extract ecosystem_dir and vuln_id.
 *
 * Handles two layouts:
 *   - Per-ecosystem ZIPs: "PyPI/PYSEC-2024-1.json" (has directory prefix)
 *   - all.zip: "ALBA-2019:0973.json" (flat, no directory)
 *
 * When the path is flat, ecosystemDir is set to "" and must be
 * derived from the JSON content after parsing.
 */
function parseZipEntryPath(entryPath: string): ZipEntryInfo | null {
    // Skip non-JSON files and directories
    if (!entryPath.endsWith(".json") || entryPath.endsWith("/")) {
        return null;
    }

    const parts = entryPath.split("/");

    if (parts.length >= 2) {
        // Path has directory structure: ecosystem_dir/[subdir/]vuln_id.json
        const ecosystemDir = parts[0]!;
        const filename = parts[parts.length - 1]!;
        const vulnId = filename.replace(/\.json$/, "");
        return { path: entryPath, ecosystemDir, vulnId };
    }

    // Flat filename from all.zip: vuln_id.json
    const vulnId = entryPath.replace(/\.json$/, "");
    return { path: entryPath, ecosystemDir: "", vulnId };
}

/**
 * Read all bytes from a readable stream.
 *
 * Deliberately event-based rather than `for await`: yauzl serves a *stored*
 * (uncompressed) entry straight from its own reader, and async iteration over
 * that stream never yields — it hangs forever, with no timeout above it to cut
 * it short. Deflated entries go through a zlib Transform and iterate fine,
 * which is why all.zip has never tripped it. One stored entry would.
 */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
        });
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Create a Transform stream that logs download progress at a regular interval.
 */
function createProgressTransform(contentLength: number | undefined, intervalMs = 5_000): Transform {
    let bytesReceived = 0;
    let lastLogTime = Date.now();

    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            bytesReceived += chunk.length;
            const now = Date.now();

            if (now - lastLogTime >= intervalMs) {
                lastLogTime = now;
                if (contentLength) {
                    const pct = ((bytesReceived / contentLength) * 100).toFixed(1);
                    log.info(
                        { bytesReceived, contentLength, percent: pct },
                        `Download progress: ${formatBytes(bytesReceived)} / ${formatBytes(contentLength)} (${pct}%)`
                    );
                } else {
                    log.info(
                        { bytesReceived },
                        `Download progress: ${formatBytes(bytesReceived)}`
                    );
                }
            }

            callback(null, chunk);
        },
    });
}

export function createZipProcessor(downloader: OsvDownloader): ZipProcessor {
    return {
        async processZip(
            url: string,
            onRecord: (record: ParsedOsvRecord, entry: ZipEntryInfo) => Promise<void>,
            options?: ZipProcessOptions
        ): Promise<ZipProcessorResult> {
            // Create a temporary directory for the ZIP file
            const tempDir = join(tmpdir(), `osv-sync-${randomBytes(8).toString("hex")}`);
            const tempZipPath = join(tempDir, "archive.zip");

            mkdirSync(tempDir, { recursive: true });

            let processedCount = 0;
            let errorCount = 0;
            let maxModifiedTimestamp: Date | null = null;
            const errors: string[] = [];

            try {
                // Download ZIP file to temp location
                const { body, contentLength } = await downloader.streamDownload(url);

                log.info(
                    { url, tempPath: tempZipPath, contentLength: contentLength ? formatBytes(contentLength) : "unknown" },
                    `Downloading archive (${contentLength ? formatBytes(contentLength) : "unknown size"})`
                );

                // Convert web stream to node stream and pipe through progress tracker to file
                const nodeStream = Readable.fromWeb(body as import("stream/web").ReadableStream);
                const progressStream = createProgressTransform(contentLength);
                await pipeline(nodeStream, progressStream, createWriteStream(tempZipPath));

                log.info({ contentLength, tempPath: tempZipPath }, "Download complete, processing ZIP");

                // Dynamically import yauzl (ESM)
                const yauzl = await import("yauzl");

                // Open ZIP file
                const zipFile = await new Promise<import("yauzl").ZipFile>((resolve, reject) => {
                    yauzl.open(tempZipPath, { lazyEntries: true }, (err, zf) => {
                        if (err) reject(err);
                        else if (zf) resolve(zf);
                        else reject(new Error("Failed to open ZIP file"));
                    });
                });

                const totalEntries = zipFile.entryCount;
                log.info({ totalEntries }, "Processing ZIP entries");

                let entriesRead = 0;
                let skippedEntries = 0;

                // Process entries
                await new Promise<void>((resolve, reject) => {
                    zipFile.on("error", reject);

                    zipFile.on("entry", async (entry: import("yauzl").Entry) => {
                        entriesRead++;

                        if (entriesRead % 50_000 === 0) {
                            log.info(
                                { entriesRead, processedCount, errorCount, skippedEntries },
                                "ZIP processing progress"
                            );
                        }

                        try {
                            const entryInfo = parseZipEntryPath(entry.fileName);

                            if (!entryInfo || (options?.filter && !options.filter(entryInfo))) {
                                skippedEntries++;
                                zipFile.readEntry();
                                return;
                            }

                            // Read entry contents
                            const readStream = await new Promise<NodeJS.ReadableStream>(
                                (resolveStream, rejectStream) => {
                                    zipFile.openReadStream(entry, (err, stream) => {
                                        if (err) rejectStream(err);
                                        else if (stream) resolveStream(stream);
                                        else rejectStream(new Error("Failed to open read stream"));
                                    });
                                }
                            );

                            const rawBytes = await streamToBuffer(readStream);

                            // Parse phase — only JSON/schema errors are caught here.
                            // Consumer (onRecord) errors are handled separately below
                            // and abort the run; see ZipRecordConsumerError.
                            let record: ParsedOsvRecord;
                            try {
                                record = parseOsvJson(
                                    rawBytes,
                                    entryInfo.ecosystemDir,
                                    downloader.computeSha256
                                );

                                // For flat paths (all.zip), derive ecosystemDir from JSON content
                                if (!entryInfo.ecosystemDir) {
                                    entryInfo.ecosystemDir = extractEcosystemDir(record.raw);
                                }
                            } catch (parseError) {
                                errorCount++;
                                const msg = parseError instanceof Error ? parseError.message : String(parseError);
                                errors.push(`Failed to process ${entry.fileName}: ${msg}`);
                                if (errorCount <= 10) {
                                    log.warn({ entry: entry.fileName, error: parseError }, "Parse error");
                                }
                                options?.onError?.({
                                    sourcePath: entry.fileName,
                                    ecosystemDir: entryInfo.ecosystemDir || null,
                                    osvId: entryInfo.vulnId || null,
                                    errorType: "parse_error",
                                    errorMessage: msg,
                                });
                                zipFile.readEntry();
                                return;
                            }

                            // Process phase — a failure here is the consumer's, not
                            // OSV's, and must take the whole run down with it.
                            try {
                                await onRecord(record, entryInfo);
                            } catch (consumerError) {
                                throw new ZipRecordConsumerError(entry.fileName, consumerError);
                            }
                            processedCount++;

                            // Track max modified timestamp
                            if (
                                !maxModifiedTimestamp ||
                                record.modified > maxModifiedTimestamp
                            ) {
                                maxModifiedTimestamp = record.modified;
                            }

                            // Report progress
                            if (options?.onProgress && processedCount % 1000 === 0) {
                                options.onProgress(processedCount, totalEntries);
                            }

                            // Continue to next entry
                            zipFile.readEntry();
                        } catch (entryError) {
                            if (entryError instanceof ZipRecordConsumerError) {
                                // Fatal. Stop reading entries and fail the run.
                                log.error(
                                    { entry: entry.fileName, error: entryError.cause },
                                    "Record consumer failed — aborting ZIP processing"
                                );
                                // Reject before closing: close() can emit "end",
                                // and whichever settles the promise first wins.
                                reject(entryError);
                                zipFile.close();
                                return;
                            }

                            errorCount++;
                            const msg = entryError instanceof Error ? entryError.message : String(entryError);
                            errors.push(`Error processing entry ${entry.fileName}: ${msg}`);
                            // Do NOT forward to onError: what reaches here is an archive-level
                            // read failure, not an OSV parse failure, and its message can carry
                            // arbitrary internals into the failure table.
                            log.error({ entry: entry.fileName, error: entryError }, "Entry read error");
                            zipFile.readEntry();
                        }
                    });

                    zipFile.on("end", () => {
                        resolve();
                    });

                    // Start reading entries
                    zipFile.readEntry();
                });

                log.info(
                    { processedCount, errorCount, entriesRead, skippedEntries },
                    "ZIP processing complete"
                );
            } finally {
                // Clean up temp directory
                if (existsSync(tempDir)) {
                    try {
                        rmSync(tempDir, { recursive: true, force: true });
                    } catch (cleanupError) {
                        log.warn({ tempDir, error: cleanupError }, "Failed to clean up temp directory");
                    }
                }
            }

            return {
                processedCount,
                errorCount,
                maxModifiedTimestamp,
                errors: errors.slice(0, 100), // Limit error list
            };
        },
    };
}
