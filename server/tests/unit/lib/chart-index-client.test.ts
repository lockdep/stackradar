/**
 * `lib/chart-index-client.ts` — the product's one read of the public chart
 * index. Refusal-first: everything it cannot say is `null`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const summary = {
    resolved: 212,
    introduced: 3,
    unchanged: 19,
    resolvedKev: 1,
    introducedKev: 0,
    resolvedHigh: 40,
    riskBefore: 900,
    riskAfter: 120,
    riskChange: -780,
};
const query = {
    repoUrl: "https://prometheus-community.github.io/helm-charts",
    chart: "kube-prometheus-stack",
    from: "65.1.0",
    to: "68.2.0",
};

async function load(env: Record<string, string>) {
    vi.resetModules();
    for (const key of ["CHART_INDEX_URL", "CHART_INDEX_DELTA_KEY"]) delete process.env[key];
    Object.assign(process.env, env);
    return import("../../../src/lib/chart-index-client.js");
}

const CONFIGURED = { CHART_INDEX_URL: "https://charts.example", CHART_INDEX_DELTA_KEY: "k" };

describe("chartIndexDelta", () => {
    beforeEach(() => vi.restoreAllMocks());

    it("is silent and asks nothing when the index is not configured", async () => {
        const client = await load({});
        const fetchImpl = vi.fn();
        expect(client.chartIndexConfigured()).toBe(false);
        expect(await client.chartIndexDelta(query, fetchImpl as unknown as typeof fetch)).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("sends only the public coordinates, with the key, and returns the summary", async () => {
        const client = await load(CONFIGURED);
        const fetchImpl = vi.fn(async () =>
            Response.json({ measured: true, summary, computedAt: "2026-09-17T00:00:00.000Z" }),
        );
        const delta = await client.chartIndexDelta(query, fetchImpl as unknown as typeof fetch);

        expect(delta).toEqual({ summary, computedAt: "2026-09-17T00:00:00.000Z" });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
        expect(url.origin + url.pathname).toBe("https://charts.example/internal/chart-delta");
        expect(Object.fromEntries(url.searchParams)).toEqual(query);
        expect((init.headers as Record<string, string>)["X-Delta-Key"]).toBe("k");
    });

    it("caches an answer — a refusal too — and never a transport failure", async () => {
        const client = await load(CONFIGURED);
        const refusal = vi.fn(async () => Response.json({ measured: false, reason: "from-not-indexed" }));
        expect(await client.chartIndexDelta(query, refusal as unknown as typeof fetch)).toBeNull();
        expect(await client.chartIndexDelta(query, refusal as unknown as typeof fetch)).toBeNull();
        expect(refusal).toHaveBeenCalledTimes(1);

        client.clearChartIndexCache();
        const down = vi.fn(async () => new Response("bad gateway", { status: 502 }));
        expect(await client.chartIndexDelta(query, down as unknown as typeof fetch)).toBeNull();
        expect(await client.chartIndexDelta(query, down as unknown as typeof fetch)).toBeNull();
        expect(down).toHaveBeenCalledTimes(2);
    });

    it("refuses a body that is not the contract's shape, and a fetch that throws", async () => {
        const client = await load(CONFIGURED);
        const wrong = vi.fn(async () => Response.json({ measured: true, summary: { resolved: "many" } }));
        expect(await client.chartIndexDelta(query, wrong as unknown as typeof fetch)).toBeNull();

        client.clearChartIndexCache();
        const throws = vi.fn(async () => {
            throw new Error("timeout");
        });
        expect(await client.chartIndexDelta(query, throws as unknown as typeof fetch)).toBeNull();
    });
});
