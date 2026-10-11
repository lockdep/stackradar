/**
 * SSRF-hardened fetch for URLs a tenant controls (security review S7).
 *
 * Chart repository URLs — and the tarball URLs inside the indexes they
 * serve — are attacker-supplied input that this server fetches from inside
 * the cluster. A plain `fetch` with `redirect: "follow"` turns that into a
 * port scanner and request proxy against everything the pod can reach: the
 * API server, sibling services, cloud metadata. This wrapper:
 *
 * - resolves the hostname and rejects any address in a loopback, private
 *   (RFC1918), link-local, CGNAT, multicast or otherwise non-public range,
 *   for every address the name resolves to (IPv4 and IPv6);
 * - rejects hostnames under cluster-internal DNS suffixes outright, plus
 *   single-label names (which only resolve through the pod's search path);
 * - follows redirects manually (max {@link MAX_REDIRECTS}) and re-runs the
 *   full check on every hop — a public host redirecting to a private one is
 *   the classic bypass;
 * - requires `https:` in production. This is also the practical answer to
 *   DNS rebinding: the pre-resolve check is time-of-check, but a rebound
 *   connection to an internal host cannot present a valid certificate for
 *   the attacker's hostname, so TLS verification fails the race.
 *
 * The resulting error is a {@link SafeFetchBlockedError} for policy
 * rejections (safe to show to the user) — anything else propagates as the
 * underlying fetch/DNS error, which callers must NOT echo back to the UI
 * verbatim (status-oracle: log the detail, show something generic).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config/index.js";

export const MAX_REDIRECTS = 5;

/** Policy rejection — the message is written for end users and safe to show. */
export class SafeFetchBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SafeFetchBlockedError";
    }
}

/** DNS suffixes that only mean something inside the cluster or the cloud. */
const BLOCKED_SUFFIXES = [".cluster.local", ".svc", ".internal", ".localhost", ".local"];

function ipv4ToInt(ip: string): number {
    const parts = ip.split(".").map(Number);
    return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr4(ip: number, base: string, prefix: number): boolean {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ip & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // RFC1918
    ["100.64.0.0", 10], // CGNAT (cloud-internal ranges live here too)
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
    ["172.16.0.0", 12], // RFC1918
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.168.0.0", 16], // RFC1918
    ["198.18.0.0", 15], // benchmarking
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved + broadcast
];

/** True when `ip` (a literal, either family) must not be connected to. */
export function isBlockedAddress(ip: string): boolean {
    const family = isIP(ip);
    if (family === 4) {
        const n = ipv4ToInt(ip);
        return BLOCKED_V4.some(([base, prefix]) => inCidr4(n, base, prefix));
    }
    if (family === 6) {
        const lower = ip.toLowerCase();
        // IPv4-mapped/compatible — re-check the embedded IPv4.
        const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedAddress(mapped[1]!);
        if (lower === "::" || lower === "::1") return true;
        return (
            /^f[cd]/.test(lower) || // fc00::/7 unique-local
            /^fe[89ab]/.test(lower) || // fe80::/10 link-local
            /^ff/.test(lower) // multicast
        );
    }
    // Not a literal IP at all — the caller resolved it, so treat as blocked.
    return true;
}

/** Throws {@link SafeFetchBlockedError} unless `url` may be fetched. */
async function assertAllowedUrl(url: URL, opts: { allowHttp: boolean }): Promise<void> {
    if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
        throw new SafeFetchBlockedError(
            url.protocol === "http:"
                ? "Only https:// URLs are allowed"
                : `URL scheme ${url.protocol.replace(/:$/, "")} is not allowed`,
        );
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "");

    if (isIP(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw new SafeFetchBlockedError("URL points at a private or internal address, which is not allowed");
        }
        return;
    }

    const lower = hostname.toLowerCase();
    if (
        lower === "localhost" ||
        !lower.includes(".") || // single-label: only resolvable via the pod's DNS search path
        BLOCKED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
    ) {
        throw new SafeFetchBlockedError("URL points at a cluster-internal hostname, which is not allowed");
    }

    let addresses;
    try {
        addresses = await lookup(hostname, { all: true });
    } catch {
        throw new SafeFetchBlockedError(`Could not resolve host ${hostname}`);
    }
    if (addresses.length === 0) {
        throw new SafeFetchBlockedError(`Could not resolve host ${hostname}`);
    }
    if (addresses.some((a) => isBlockedAddress(a.address))) {
        throw new SafeFetchBlockedError("URL resolves to a private or internal address, which is not allowed");
    }
}

export interface SafeFetchOptions {
    headers?: Record<string, string>;
    /** Defaults to GET. A body is re-sent on every redirect hop, as `fetch` itself would for a 307/308. */
    method?: "GET" | "POST";
    body?: string;
    timeoutMs: number;
    /**
     * Permit plain http. Only honoured outside production — in production
     * the TLS requirement is part of the SSRF defence (see module docs).
     */
    allowInsecureHttp?: boolean;
}

/**
 * Fetch an untrusted URL with SSRF checks on the initial URL and on every
 * redirect hop. Returns the final (non-redirect) response; the caller still
 * owns status handling and body-size ceilings.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<Response> {
    const allowHttp = Boolean(opts.allowInsecureHttp) && !config.isProduction;
    const deadline = AbortSignal.timeout(opts.timeoutMs);

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new SafeFetchBlockedError("Not a valid URL");
    }

    const originalOrigin = url.origin;
    for (let hop = 0; ; hop++) {
        await assertAllowedUrl(url, { allowHttp });

        // Same rule native `fetch` applies when following redirects itself:
        // credentials configured for the original host must not travel to a
        // host a redirect chose.
        const headers = { ...(opts.headers ?? {}) };
        if (url.origin !== originalOrigin) {
            delete headers["Authorization"];
            delete headers["authorization"];
        }

        const response = await fetch(url, {
            method: opts.method ?? "GET",
            ...(opts.body !== undefined ? { body: opts.body } : {}),
            headers,
            redirect: "manual",
            signal: deadline,
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            // Drain nothing: redirect bodies are irrelevant. Cancel so the
            // connection is released.
            await response.body?.cancel().catch(() => {});
            if (!location) return response;
            if (hop >= MAX_REDIRECTS) {
                throw new SafeFetchBlockedError(`More than ${MAX_REDIRECTS} redirects`);
            }
            url = new URL(location, url);
            continue;
        }

        return response;
    }
}
