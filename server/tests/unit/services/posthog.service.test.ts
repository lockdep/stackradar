import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        posthog: { apiKey: "", host: "https://eu.i.posthog.test" },
    },
}));
vi.mock("../../../src/config/index.js", () => ({ config: mockConfig }));
vi.mock("../../../src/lib/logger.js", () => {
    const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { logger: { child: () => noop }, createLogger: () => noop };
});

import { posthogService } from "../../../src/services/posthog.service.js";

const input = { event: "signup_completed" as const, distinctId: "org-1", properties: { utm_source: "reddit" } };

describe("posthogService.capture", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        mockConfig.posthog.apiKey = "phc_test";
        mockConfig.posthog.host = "https://eu.i.posthog.test";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("returns not_configured without calling PostHog when the project token is missing", async () => {
        mockConfig.posthog.apiKey = "";
        expect(await posthogService.capture(input)).toEqual({ status: "not_configured" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(posthogService.isConfigured()).toBe(false);
    });

    it("POSTs one geo-disabled event keyed on the distinct id", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const timestamp = new Date("2026-09-26T10:00:00Z");

        const result = await posthogService.capture({ ...input, timestamp, setOnce: { utm_source: "reddit" } });

        expect(result).toEqual({ status: "sent" });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://eu.i.posthog.test/i/v0/e");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({
            api_key: "phc_test",
            event: "signup_completed",
            distinct_id: "org-1",
            timestamp: "2026-09-26T10:00:00.000Z",
            properties: {
                utm_source: "reddit",
                $set_once: { utm_source: "reddit" },
                $lib: "stackradar-server",
                $geoip_disable: true,
            },
        });
    });

    it("tolerates a trailing slash on the host", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        mockConfig.posthog.host = "https://eu.i.posthog.test/";
        await posthogService.capture(input);
        expect(fetchMock.mock.calls[0]![0]).toBe("https://eu.i.posthog.test/i/v0/e");
    });

    it("reports a non-2xx response as failed without throwing", async () => {
        fetchMock.mockResolvedValue(new Response("bad token", { status: 401 }));
        const result = await posthogService.capture(input);
        expect(result).toEqual({ status: "failed", error: "PostHog responded 401: bad token" });
    });

    it("reports a network error as failed without throwing", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNRESET"));
        const result = await posthogService.capture(input);
        expect(result).toEqual({ status: "failed", error: "ECONNRESET" });
    });
});
