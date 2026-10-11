/**
 * The size pre-flight the platform scanner runs before syft pulls an image
 * (platform-scan/image-size.ts): manifest walk, anonymous token reuse across
 * the index and its platform child, and the "unmeasured" cases that must
 * fall through to a pull rather than fail the image.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { imageLayerBytes } from "../../../src/platform-scan/image-size.js";

const IMAGE = { registry: "quay.io", repository: "argoproj/argocd", digest: "sha256:" + "e".repeat(64) };
const CHILD = "sha256:" + "c".repeat(64);
const OPTS = { timeoutMs: 1_000, userAgent: "test" };

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
}

const index = {
    manifests: [
        { digest: "sha256:" + "a".repeat(64), platform: { os: "linux", architecture: "arm64" } },
        { digest: CHILD, platform: { os: "linux", architecture: "amd64" } },
        { digest: "sha256:" + "f".repeat(64), platform: { os: "unknown", architecture: "unknown" } },
    ],
};
const leaf = {
    config: { size: 1_000 },
    layers: [{ size: 100_000 }, { size: 250_000 }],
};

describe("imageLayerBytes", () => {
    const fetchMock = vi.fn<typeof fetch>();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("sums the platform child's layers (plus config) behind an index", async () => {
        fetchMock.mockResolvedValueOnce(json(index)).mockResolvedValueOnce(json(leaf));

        const result = await imageLayerBytes(IMAGE, "linux/amd64", OPTS);

        expect(result).toEqual({ ok: true, bytes: 351_000, layers: 2 });
        const urls = fetchMock.mock.calls.map(([url]) => String(url));
        expect(urls[0]).toBe(`https://quay.io/v2/argoproj/argocd/manifests/${encodeURIComponent(IMAGE.digest)}`);
        expect(urls[1]).toBe(`https://quay.io/v2/argoproj/argocd/manifests/${encodeURIComponent(CHILD)}`);
    });

    it("sums a single manifest directly", async () => {
        fetchMock.mockResolvedValueOnce(json(leaf));

        const result = await imageLayerBytes({ ...IMAGE, registry: "docker.io" }, "linux/amd64", OPTS);

        expect(result).toEqual({ ok: true, bytes: 351_000, layers: 2 });
        expect(String(fetchMock.mock.calls[0]![0])).toContain("https://registry-1.docker.io/v2/");
    });

    it("answers one Bearer challenge and reuses the token for the child", async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response("", {
                    status: 401,
                    headers: { "www-authenticate": 'Bearer realm="https://quay.io/v2/auth",service="quay.io"' },
                }),
            )
            .mockResolvedValueOnce(json({ token: "tok-123" }))
            .mockResolvedValueOnce(json(index))
            .mockResolvedValueOnce(json(leaf));

        const result = await imageLayerBytes(IMAGE, "linux/amd64", OPTS);

        expect(result).toEqual({ ok: true, bytes: 351_000, layers: 2 });
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const tokenUrl = new URL(String(fetchMock.mock.calls[1]![0]));
        expect(tokenUrl.origin + tokenUrl.pathname).toBe("https://quay.io/v2/auth");
        expect(tokenUrl.searchParams.get("scope")).toBe("repository:argoproj/argocd:pull");
        const headersOf = (i: number) => (fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
        expect(headersOf(2)["Authorization"]).toBe("Bearer tok-123");
        expect(headersOf(3)["Authorization"]).toBe("Bearer tok-123");
    });

    it("reports 429 as rate limited", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));

        const result = await imageLayerBytes(IMAGE, "linux/amd64", OPTS);

        expect(result).toEqual({ ok: false, reason: "HTTP 429 fetching manifest", rateLimited: true });
    });

    it("is unmeasured when the index has no child for the platform", async () => {
        fetchMock.mockResolvedValueOnce(json(index));

        const result = await imageLayerBytes(IMAGE, "linux/s390x", OPTS);

        expect(result).toEqual({ ok: false, reason: "no linux/s390x manifest in the index", rateLimited: false });
    });

    it("is unmeasured when a manifest declares no layer sizes", async () => {
        fetchMock.mockResolvedValueOnce(json({ layers: [{ digest: "sha256:abc" }] }));

        const result = await imageLayerBytes(IMAGE, "linux/amd64", OPTS);

        expect(result).toEqual({ ok: false, reason: "manifest declares no layer sizes", rateLimited: false });
    });

    it("is unmeasured on a transport failure", async () => {
        fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND quay.io"));

        const result = await imageLayerBytes(IMAGE, "linux/amd64", OPTS);

        expect(result).toEqual({ ok: false, reason: "getaddrinfo ENOTFOUND quay.io", rateLimited: false });
    });
});
