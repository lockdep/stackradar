/**
 * Downloader — retry policy and timeout coverage
 *
 * Two failures worth pinning down:
 *
 *   - a 4xx that is not 429 is an answer, not an outage. The code said so in a
 *     comment while throwing inside the retry loop, so the catch picked the
 *     throw up and retried anyway: four requests and ~3.5s of jittered backoff
 *     to reconfirm a 404, multiplied by every missing record in a batch.
 *   - the request timeout used to be cleared the moment `fetch` resolved its
 *     headers, which is before a single byte of the body has been read. A
 *     connection that stalled mid-body hung until the pod's
 *     `activeDeadlineSeconds` killed it.
 *
 * `fetch` is stubbed with a body wired to the AbortSignal the way a real one is,
 * so an abort surfaces as a stream error rather than being silently ignored.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createDownloader, NonRetryableHttpError } from "../../../src/osv-sync/downloader.js";
import { loadConfig, type OsvSyncConfig } from "../../../src/osv-sync/config.js";

function testConfig(overrides: Partial<OsvSyncConfig> = {}): OsvSyncConfig {
    return {
        ...loadConfig(),
        maxRetries: 2,
        retryBaseDelayMs: 1,
        requestTimeoutMs: 100,
        streamStallTimeoutMs: 100,
        ...overrides,
    };
}

/** A body that never completes, and errors when the request is aborted. */
function stallingBody(signal: AbortSignal): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            signal.addEventListener("abort", () => {
                controller.error(signal.reason ?? new Error("aborted"));
            });
        },
    });
}

function okResponse(body: string): Response {
    return new Response(body, { status: 200 });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createDownloader retry policy", () => {
    it("does not retry a 404", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig());

        await expect(downloader.download("https://example.com/missing.json")).rejects.toBeInstanceOf(
            NonRetryableHttpError
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 500 up to maxRetries", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig({ maxRetries: 2 }));

        await expect(downloader.download("https://example.com/flaky.json")).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("retries a 429 despite it being a 4xx", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
            .mockResolvedValueOnce(okResponse("{}"));
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig());
        const result = await downloader.download("https://example.com/rate-limited.json");

        expect(result.data.toString()).toBe("{}");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("createDownloader timeout coverage", () => {
    it("aborts a response whose body stalls after the headers arrive", async () => {
        const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
            Promise.resolve(new Response(stallingBody(init.signal as AbortSignal), { status: 200 }))
        );
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig({ requestTimeoutMs: 50 }));

        // Before the fix this resolved its headers and then hung forever.
        await expect(downloader.download("https://example.com/stalls.json")).rejects.toThrow();
    }, 5_000);

    it("aborts a streamed download that goes quiet mid-body", async () => {
        const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
            const signal = init.signal as AbortSignal;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    // One chunk, then silence — a fixed overall deadline cannot
                    // tell this apart from a legitimately slow 1.35 GB transfer.
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    signal.addEventListener("abort", () => {
                        controller.error(signal.reason ?? new Error("aborted"));
                    });
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        });
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig({ streamStallTimeoutMs: 50 }));
        const { body } = await downloader.streamDownload("https://example.com/all.zip");

        const reader = body.getReader();
        await expect(reader.read()).resolves.toMatchObject({ done: false });
        await expect(reader.read()).rejects.toThrow(/stalled/);
    }, 5_000);

    it("lets a slow but progressing stream through", async () => {
        const fetchMock = vi.fn().mockImplementation(() => {
            let sent = 0;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (sent === 3) {
                        controller.close();
                        return;
                    }
                    // Each gap is under the stall timeout, so the timer re-arms
                    // and the transfer is left alone however long it takes.
                    await new Promise((resolve) => setTimeout(resolve, 30));
                    sent++;
                    controller.enqueue(new Uint8Array([sent]));
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        });
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig({ streamStallTimeoutMs: 100 }));
        const { body } = await downloader.streamDownload("https://example.com/all.zip");

        let chunks = 0;
        for await (const _chunk of body as unknown as AsyncIterable<Uint8Array>) chunks++;
        expect(chunks).toBe(3);
    }, 5_000);
});

describe("streamLines", () => {
    it("yields lines and stops the transfer when the caller breaks out", async () => {
        let cancelled = false;
        const fetchMock = vi.fn().mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("a,x/1\nb,x/2\nc,x/3\n"));
                },
                cancel() {
                    cancelled = true;
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        });
        vi.stubGlobal("fetch", fetchMock);

        const downloader = createDownloader(testConfig());

        const seen: string[] = [];
        for await (const line of downloader.streamLines("https://example.com/modified_id.csv")) {
            seen.push(line);
            if (seen.length === 2) break;
        }

        // Teardown runs through readline → node stream → web stream, all async.
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(seen).toEqual(["a,x/1", "b,x/2"]);
        // Abandoning the iterator has to tear the connection down; otherwise the
        // early stop saves parsing but still pays for all 45.8 MB.
        expect(cancelled).toBe(true);
    }, 5_000);
});
