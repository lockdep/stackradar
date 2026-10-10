/**
 * The product's one read of the public chart index (charts.stackradar.io):
 * what moving a public chart between two versions does to the findings on
 * its default-rendered image set. Contract: `docs/contracts/match-endpoint.md`
 * § Chart delta; the other side is `charts/src/app/internal/chart-delta`.
 *
 * It exists for one sentence on the Fixes page. An unmeasured chart bump may
 * only say "a newer chart exists"; when the index has rendered and scored
 * both versions, the same row can say "upgrading to 68.2 removes 212
 * findings" — measured, on the chart's **default values**, by someone who is
 * not us-in-this-cluster. It is evidence of a third kind, and the row says so
 * (`evidence: "chart-index"`): not a diff of two SBOMs this org holds, and
 * not the platform's own candidate render.
 *
 * Refusal-first, like everything on that page: unconfigured, slow, down, or
 * "we have not indexed that version" all come back `null` and the row stays
 * unmeasured. Nothing a customer owns crosses this boundary — the request is
 * a public repository URL, a chart name and two version strings.
 */

import { config } from "../config/index.js";
import { createLogger } from "./logger.js";
import type { DeltaSummary } from "../db/finding-delta.js";

const log = createLogger("chart-index-client");

const TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60 * 60 * 1_000;
const CACHE_MAX = 2_000;

export interface ChartIndexDelta {
    summary: DeltaSummary;
    computedAt: string;
}

type Cached = { at: number; value: ChartIndexDelta | null };
const cache = new Map<string, Cached>();

type Fetch = typeof fetch;

/** Whether the index is configured at all — the caller skips the fan-out when it is not. */
export function chartIndexConfigured(): boolean {
    return Boolean(config.chartIndex.url && config.chartIndex.deltaKey);
}

function isSummary(value: unknown): value is DeltaSummary {
    if (typeof value !== "object" || value === null) return false;
    const s = value as Record<string, unknown>;
    return ["resolved", "introduced", "unchanged", "resolvedKev", "introducedKev", "resolvedHigh", "riskBefore", "riskAfter", "riskChange"].every(
        (k) => typeof s[k] === "number" && Number.isFinite(s[k])
    );
}

/**
 * The measured delta of one chart move, or null. Cached for an hour per
 * `(repoUrl, chart, from, to)` — refusals too, so a page of unmeasured rows
 * does not ask the same unanswerable question on every load.
 */
export async function chartIndexDelta(
    input: { repoUrl: string; chart: string; from: string; to: string },
    fetchImpl: Fetch = fetch
): Promise<ChartIndexDelta | null> {
    if (!chartIndexConfigured()) return null;

    const key = JSON.stringify([input.repoUrl, input.chart, input.from, input.to]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    let value: ChartIndexDelta | null = null;
    try {
        const url = new URL("/internal/chart-delta", config.chartIndex.url);
        for (const [k, v] of Object.entries(input)) url.searchParams.set(k, v);
        const response = await fetchImpl(url, {
            headers: { "X-Delta-Key": config.chartIndex.deltaKey, Accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            await response.arrayBuffer().catch(() => undefined);
            // Not cached: a 5xx or a bad key is about this minute, not about the pair.
            log.warn({ status: response.status }, "Chart index refused a delta request");
            return null;
        }
        const body = (await response.json()) as { measured?: unknown; summary?: unknown; computedAt?: unknown };
        if (body.measured === true && isSummary(body.summary)) {
            value = { summary: body.summary, computedAt: typeof body.computedAt === "string" ? body.computedAt : "" };
        }
    } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, "Chart index unreachable");
        return null;
    }

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value });
    return value;
}

/** Test seam. */
export function clearChartIndexCache(): void {
    cache.clear();
}
