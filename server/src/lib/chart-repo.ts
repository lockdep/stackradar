/**
 * Reading a Helm chart repository's `index.yaml` —
 * [fix-tab-suggestions.md](../../../docs/proposals/fix-tab-suggestions.md)
 * phase 2.
 *
 * A chart repository *is* an `index.yaml` URL: Bitnami, ChartMuseum, Harbor
 * and GitHub-Pages-hosted repos all serve the same document, so one fetcher
 * covers them all. (OCI-hosted charts speak the registry tags API instead —
 * a fast-follow, not this module.)
 *
 * What an index can honestly supply is *versions that exist*. Everything
 * built on it is therefore an **unmeasured** claim, and stays in that band of
 * the suggestion feed.
 *
 * Cost discipline, per the proposal's notes:
 * - fetches are conditional (`If-None-Match`) so the daily refresh of an
 *   unchanged Bitnami-scale index is a 304;
 * - a hard byte ceiling, enforced while streaming, refuses indexes we are
 *   not prepared to parse — the parse is synchronous, so the ceiling is also
 *   the event-loop budget;
 * - parsing trims to the charts the org actually runs before anything is
 *   stored, and caps versions per chart;
 * - nothing here runs in a request path — callers are the worker's daily
 *   sync and the `chart_repo_refresh` job the settings page's Refresh button
 *   enqueues. The index URL is user-supplied, so "never in the API process"
 *   is a security property (security-review-2026-08-22.md § S1), not a
 *   latency preference.
 */

import { parse } from "yaml";
import { config } from "../config/index.js";
import type { ChartRepoVersion } from "../db/schema/chart-repositories.js";
import { createLogger } from "./logger.js";
import { safeFetch, SafeFetchBlockedError } from "./safe-fetch.js";

const log = createLogger("chart-repo");

/**
 * Refuse to download an index larger than this. Bitnami's — the largest
 * public index anyone is likely to register — is ~3 MB; a 5 MB default is
 * generous. The ceiling is also the parse-time budget: `yaml.parse` is
 * synchronous and roughly linear in document size, so a 42 MB index costs
 * ~60 s of blocked event loop. Configurable via `CHART_REPO_MAX_INDEX_BYTES`.
 */
export const MAX_INDEX_BYTES = config.chartRepo.maxIndexBytes;

/** Versions kept per chart — far more than any ordering decision needs. */
export const MAX_VERSIONS_PER_CHART = 200;

const FETCH_TIMEOUT_MS = 60_000;

/** `https://repo.example/charts` → `https://repo.example/charts/index.yaml`. */
export function indexUrl(repoUrl: string): string {
    const base = repoUrl.replace(/\/+$/, "");
    return `${base}/index.yaml`;
}

/** Only plain HTTP(S) repositories can serve an `index.yaml`. */
export function isIndexableRepoUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

export interface ParsedIndexEntry {
    chartName: string;
    versions: ChartRepoVersion[];
}

/**
 * Resolve an `index.yaml` `urls` entry the way the Helm client does: an
 * absolute URL is kept as-is, a relative one resolves against the repository
 * root. Anything that fails to resolve — or resolves to a non-http(s) scheme —
 * is null: a tarball we cannot fetch is a tarball we do not claim to know.
 */
export function resolveTarballUrl(url: unknown, repoUrl: string | null): string | null {
    if (typeof url !== "string" || url.length === 0) return null;
    try {
        const resolved = repoUrl
            ? new URL(url, `${repoUrl.replace(/\/+$/, "")}/`)
            : new URL(url);
        return /^https?:$/i.test(resolved.protocol) ? resolved.toString() : null;
    } catch {
        return null;
    }
}

/**
 * Parse an `index.yaml`, keeping only `keepCharts` (or everything when null —
 * tests and tiny private hubs). Malformed entries cost themselves, not the
 * document: a chart whose version list is not a list is skipped.
 *
 * `repoUrl` resolves each version's relative tarball URL; null keeps only
 * absolute ones (a caller that does not know the root cannot resolve).
 */
export function parseIndexYaml(
    text: string,
    keepCharts: ReadonlySet<string> | null,
    repoUrl: string | null = null
): ParsedIndexEntry[] {
    const doc = parse(text) as unknown;
    if (doc == null || typeof doc !== "object") {
        throw new Error("index.yaml is not a YAML mapping");
    }
    const entries = (doc as { entries?: unknown }).entries;
    if (entries == null || typeof entries !== "object") {
        throw new Error("index.yaml has no entries mapping");
    }

    const out: ParsedIndexEntry[] = [];
    for (const [chartName, value] of Object.entries(entries as Record<string, unknown>)) {
        if (keepCharts && !keepCharts.has(chartName)) continue;
        if (!Array.isArray(value)) continue;

        const versions: ChartRepoVersion[] = [];
        for (const item of value) {
            if (versions.length >= MAX_VERSIONS_PER_CHART) break;
            if (item == null || typeof item !== "object") continue;
            const version = (item as { version?: unknown }).version;
            if (typeof version !== "string" || version.length === 0) continue;
            const appVersion = (item as { appVersion?: unknown }).appVersion;
            const urls = (item as { urls?: unknown }).urls;
            versions.push({
                version,
                appVersion: typeof appVersion === "string" ? appVersion : null,
                // First URL per version, as the Helm client picks it. The rest
                // are mirrors of the same artifact.
                tarballUrl: resolveTarballUrl(Array.isArray(urls) ? urls[0] : null, repoUrl),
            });
        }
        if (versions.length > 0) out.push({ chartName, versions });
    }
    return out;
}

export type IndexFetchResult =
    | { status: "not-modified" }
    | { status: "ok"; etag: string | null; text: string }
    | { status: "error"; message: string };

/**
 * Conditional GET of a repository's index. Never throws — a repository that
 * is down, private without credentials, or oversized reports itself as an
 * error the settings page can show, and costs nothing else.
 */
export async function fetchIndex(repo: {
    url: string;
    etag: string | null;
    username: string | null;
    password: string | null;
}): Promise<IndexFetchResult> {
    if (!isIndexableRepoUrl(repo.url)) {
        return {
            status: "error",
            message: "Only http(s) chart repositories are supported (OCI is not yet)",
        };
    }

    const headers: Record<string, string> = { Accept: "application/x-yaml, text/yaml, */*" };
    if (repo.etag) headers["If-None-Match"] = repo.etag;
    if (repo.username != null && repo.password != null) {
        headers["Authorization"] =
            "Basic " + Buffer.from(`${repo.username}:${repo.password}`).toString("base64");
    }

    let response: Response;
    try {
        // SSRF guard (S7): private/internal targets are rejected, redirects
        // re-checked per hop, and https required in production. `allowInsecureHttp`
        // keeps local http registries usable in development and tests.
        response = await safeFetch(indexUrl(repo.url), {
            headers,
            timeoutMs: FETCH_TIMEOUT_MS,
            allowInsecureHttp: true,
        });
    } catch (err) {
        if (err instanceof SafeFetchBlockedError) {
            return { status: "error", message: err.message };
        }
        // Do not surface the raw error: connect/DNS failures phrase
        // themselves differently per target and become a network oracle for
        // whatever the URL pointed at. Detail goes to the logs only.
        log.warn(
            { err, repoUrl: repo.url },
            "chart repository index fetch failed"
        );
        return { status: "error", message: "Could not fetch the repository index" };
    }

    if (response.status === 304) return { status: "not-modified" };
    if (!response.ok) {
        return { status: "error", message: `HTTP ${response.status} fetching index.yaml` };
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_INDEX_BYTES) {
        return {
            status: "error",
            message: `index.yaml is ${declared} bytes; refusing anything over ${MAX_INDEX_BYTES}`,
        };
    }

    // Stream with a hard cutoff rather than `response.text()`: a chunked
    // response carries no content-length, and buffering it to completion
    // before checking the size would let the server decide our memory use.
    const text = await readBodyWithCeiling(response, MAX_INDEX_BYTES);
    if (text === null) {
        return {
            status: "error",
            message: `index.yaml exceeds the ${MAX_INDEX_BYTES}-byte ceiling`,
        };
    }

    return { status: "ok", etag: response.headers.get("etag"), text };
}

/**
 * Read a response body as UTF-8, aborting the stream — and returning null —
 * the moment more than `maxBytes` have arrived.
 */
export async function readBodyWithCeiling(response: Response, maxBytes: number): Promise<string | null> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
}
