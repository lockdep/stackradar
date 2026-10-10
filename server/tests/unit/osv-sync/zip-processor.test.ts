/**
 * ZIP Processor — failure classification
 *
 * The processor sees two kinds of failure and must not treat them alike:
 *
 *   - a record that will not parse is a fact about OSV's data. Skip it, count
 *     it, keep going: one advisory is not worth abandoning a 1.35 GB import.
 *   - a failure in the `onRecord` consumer is a fact about *us* — in production
 *     it is the database write. Those must abort the run, because a bootstrap
 *     visits each record exactly once and incremental sync never revisits
 *     anything below the watermark, so a swallowed write error is a permanent
 *     hole in the mirror that reports itself as a healthy sync.
 *
 * The archives here are built in-memory, deflated exactly as OSV's all.zip is,
 * which keeps the test free of fixture files while exercising the same yauzl
 * path production takes.
 */

import { describe, it, expect, vi } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { Readable } from "node:stream";

import { createZipProcessor, ZipRecordConsumerError } from "../../../src/osv-sync/zip-processor.js";
import type { OsvDownloader } from "../../../src/osv-sync/downloader.js";

// ---------------------------------------------------------------------------
// A minimal deflate ZIP writer
// ---------------------------------------------------------------------------

function buildZip(entries: { name: string; content: string; stored?: boolean }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.name, "utf8");
        const raw = Buffer.from(entry.content, "utf8");
        const data = entry.stored ? raw : deflateRawSync(raw);
        const method = entry.stored ? 0 : 8;
        const sum = crc32(raw);

        const local = Buffer.alloc(30 + nameBytes.length);
        local.writeUInt32LE(0x04034b50, 0); // local file header signature
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(method, 8); // deflate, as in all.zip, unless asked otherwise
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0, 12); // mod date
        local.writeUInt32LE(sum, 14);
        local.writeUInt32LE(data.length, 18); // compressed size
        local.writeUInt32LE(raw.length, 22); // uncompressed size
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28); // extra length
        nameBytes.copy(local, 30);

        const central = Buffer.alloc(46 + nameBytes.length);
        central.writeUInt32LE(0x02014b50, 0); // central directory signature
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0, 8); // flags
        central.writeUInt16LE(method, 10); // method
        central.writeUInt16LE(0, 12); // mod time
        central.writeUInt16LE(0, 14); // mod date
        central.writeUInt32LE(sum, 16);
        central.writeUInt32LE(data.length, 20); // compressed size
        central.writeUInt32LE(raw.length, 24); // uncompressed size
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42); // local header offset
        nameBytes.copy(central, 46);

        locals.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralBuf, end]);
}

function osvRecord(id: string): string {
    return JSON.stringify({
        id,
        modified: "2024-06-01T00:00:00Z",
        affected: [{ package: { name: "lodash", ecosystem: "npm" } }],
    });
}

function downloaderServing(zip: Buffer): OsvDownloader {
    return {
        streamDownload: vi.fn().mockResolvedValue({
            body: Readable.toWeb(Readable.from(zip)),
            contentLength: zip.length,
        }),
        computeSha256: (data: Buffer) => data.subarray(0, 32),
    } as unknown as OsvDownloader;
}

describe("createZipProcessor", () => {
    it("processes every entry and tracks the newest modified timestamp", async () => {
        const zip = buildZip([
            { name: "npm/CVE-2024-0001.json", content: osvRecord("CVE-2024-0001") },
            { name: "npm/CVE-2024-0002.json", content: osvRecord("CVE-2024-0002") },
        ]);
        const seen: string[] = [];

        const result = await createZipProcessor(downloaderServing(zip)).processZip(
            "https://example.com/all.zip",
            async (record) => {
                seen.push(record.id);
            }
        );

        expect(seen).toEqual(["CVE-2024-0001", "CVE-2024-0002"]);
        expect(result.processedCount).toBe(2);
        expect(result.errorCount).toBe(0);
        expect(result.maxModifiedTimestamp).toEqual(new Date("2024-06-01T00:00:00Z"));
    });

    it("reads a stored (uncompressed) entry instead of hanging on it", async () => {
        // all.zip deflates everything today, and only the deflate path survives
        // async iteration — so a stored entry is exactly the case a `for await`
        // implementation passes every test on and then hangs forever in prod.
        const zip = buildZip([
            { name: "npm/CVE-2024-0001.json", content: osvRecord("CVE-2024-0001"), stored: true },
        ]);
        const seen: string[] = [];

        const result = await createZipProcessor(downloaderServing(zip)).processZip(
            "https://example.com/all.zip",
            async (record) => {
                seen.push(record.id);
            }
        );

        expect(seen).toEqual(["CVE-2024-0001"]);
        expect(result.processedCount).toBe(1);
    }, 10_000);

    it("skips an unparseable record and keeps going", async () => {
        const zip = buildZip([
            { name: "npm/BROKEN.json", content: "{ not json" },
            { name: "npm/CVE-2024-0002.json", content: osvRecord("CVE-2024-0002") },
        ]);
        const onError = vi.fn();
        const seen: string[] = [];

        const result = await createZipProcessor(downloaderServing(zip)).processZip(
            "https://example.com/all.zip",
            async (record) => {
                seen.push(record.id);
            },
            { onError }
        );

        expect(seen).toEqual(["CVE-2024-0002"]);
        expect(result.processedCount).toBe(1);
        expect(result.errorCount).toBe(1);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ errorType: "parse_error", sourcePath: "npm/BROKEN.json" })
        );
    });

    it("aborts the whole run when the consumer fails", async () => {
        const zip = buildZip([
            { name: "npm/CVE-2024-0001.json", content: osvRecord("CVE-2024-0001") },
            { name: "npm/CVE-2024-0002.json", content: osvRecord("CVE-2024-0002") },
            { name: "npm/CVE-2024-0003.json", content: osvRecord("CVE-2024-0003") },
        ]);
        const seen: string[] = [];

        const run = createZipProcessor(downloaderServing(zip)).processZip(
            "https://example.com/all.zip",
            async (record) => {
                seen.push(record.id);
                if (record.id === "CVE-2024-0002") {
                    throw new Error("connection terminated unexpectedly");
                }
            }
        );

        await expect(run).rejects.toBeInstanceOf(ZipRecordConsumerError);
        await expect(run).rejects.toThrow("connection terminated unexpectedly");

        // Stopped at the failure rather than carrying on through the archive.
        expect(seen).toEqual(["CVE-2024-0001", "CVE-2024-0002"]);
    });

    it("does not report a consumer failure as a per-record parse failure", async () => {
        const zip = buildZip([
            { name: "npm/CVE-2024-0001.json", content: osvRecord("CVE-2024-0001") },
        ]);
        const onError = vi.fn();

        await expect(
            createZipProcessor(downloaderServing(zip)).processZip(
                "https://example.com/all.zip",
                async () => {
                    // A database error carries SQL and internals; it has no business
                    // in osv_sync_failures, which exists to describe OSV's data.
                    throw new Error("insert into vulnerabilities ... failed");
                },
                { onError }
            )
        ).rejects.toBeInstanceOf(ZipRecordConsumerError);

        expect(onError).not.toHaveBeenCalled();
    });
});
