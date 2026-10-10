/**
 * SSRF guard (security review S7). The load-bearing assertions are the
 * refusals: every address class the pod can reach but a chart repository has
 * no business being — loopback, RFC1918, link-local (cloud metadata),
 * cluster DNS names — must be rejected before any connection is attempted.
 */

import { describe, it, expect } from "vitest";
import { isBlockedAddress, safeFetch, SafeFetchBlockedError } from "../../../src/lib/safe-fetch.js";

describe("isBlockedAddress", () => {
    it.each([
        "127.0.0.1",
        "127.255.255.255",
        "10.0.0.5",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "::ffff:10.0.0.5",
        "::ffff:127.0.0.1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "ff02::1",
    ])("blocks %s", (ip) => {
        expect(isBlockedAddress(ip)).toBe(true);
    });

    it.each([
        "1.1.1.1",
        "8.8.8.8",
        "104.16.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "2606:4700::1111",
        "::ffff:8.8.8.8",
    ])("allows %s", (ip) => {
        expect(isBlockedAddress(ip)).toBe(false);
    });

    it("treats a non-IP as blocked", () => {
        expect(isBlockedAddress("not-an-ip")).toBe(true);
    });
});

describe("safeFetch policy rejections", () => {
    const expectBlocked = async (url: string) => {
        await expect(safeFetch(url, { timeoutMs: 1000, allowInsecureHttp: true })).rejects.toThrow(
            SafeFetchBlockedError
        );
    };

    it("rejects loopback literals", async () => {
        await expectBlocked("http://127.0.0.1:8080/index.yaml");
        await expectBlocked("http://[::1]:8080/index.yaml");
    });

    it("rejects private-range literals", async () => {
        await expectBlocked("http://10.0.0.5:8080/");
        await expectBlocked("http://192.168.1.10/");
        await expectBlocked("http://169.254.169.254/latest/meta-data/");
    });

    it("rejects localhost and single-label hostnames", async () => {
        await expectBlocked("http://localhost:3001/metrics");
        // Single-label names only resolve through the pod's DNS search path —
        // `http://prod-server:3001` is exactly the internal-service probe S7 describes.
        await expectBlocked("http://prod-server:3001/metrics");
    });

    it("rejects cluster-internal DNS suffixes", async () => {
        await expectBlocked("http://server.stack-radar-prod.svc/");
        await expectBlocked("http://server.stack-radar-prod.svc.cluster.local/");
        await expectBlocked("http://something.internal/");
    });

    it("rejects non-http(s) schemes", async () => {
        await expectBlocked("file:///etc/passwd");
        await expectBlocked("ftp://example.com/");
    });

    it("rejects http when not explicitly allowed", async () => {
        await expect(safeFetch("http://example.com/", { timeoutMs: 1000 })).rejects.toThrow(
            /Only https/
        );
    });

    it("rejects garbage URLs", async () => {
        await expectBlocked("not a url");
    });
});
