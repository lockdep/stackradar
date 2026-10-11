import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        appUrl: "https://app.test",
        reddit: {
            pixelId: "",
            conversionsToken: "",
            conversionsApiUrl: "https://ads-api.reddit.test/api/v3/pixels",
            testId: "",
        },
    },
}));
vi.mock("../../../src/config/index.js", () => ({ config: mockConfig }));
vi.mock("../../../src/lib/logger.js", () => {
    const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { logger: { child: () => noop }, createLogger: () => noop };
});

import { redditConversionsService } from "../../../src/cloud/attribution/reddit-conversions.service.js";

const input = { trackingType: "SIGN_UP" as const, clickId: "abc123", conversionId: "signup:u1" };

describe("redditConversionsService.send", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        mockConfig.reddit.pixelId = "a2_test";
        mockConfig.reddit.conversionsToken = "tok_test";
        mockConfig.reddit.testId = "";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("returns not_configured without calling Reddit when pixel id or token is missing", async () => {
        mockConfig.reddit.conversionsToken = "";
        expect(await redditConversionsService.send(input)).toEqual({ status: "not_configured" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(redditConversionsService.isConfigured()).toBe(false);
    });

    it("POSTs one event carrying only the click id and a conversion id", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        const eventAt = new Date("2026-09-13T10:00:00Z");

        const result = await redditConversionsService.send({ ...input, eventAt });

        expect(result).toEqual({ status: "sent" });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://ads-api.reddit.test/api/v3/pixels/a2_test/conversion_events");
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({ Authorization: "Bearer tok_test", "User-Agent": "stackradar-server" });
        expect(JSON.parse(init.body)).toEqual({
            data: {
                events: [
                    {
                        event_at: eventAt.getTime(),
                        action_source: "WEBSITE",
                        event_source_url: "https://app.test/login",
                        type: { tracking_type: "SIGN_UP" },
                        click_id: "abc123",
                        metadata: { conversion_id: "signup:u1" },
                    },
                ],
            },
        });
        // The privacy policy's promise: no email, IP or user agent in the event.
        expect(JSON.parse(init.body).data.events[0]).not.toHaveProperty("user");
    });

    it("routes the batch to Events Manager's test view when a test id is configured", async () => {
        mockConfig.reddit.testId = "TEST123";
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        await redditConversionsService.send(input);
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body).data.test_id).toBe("TEST123");
    });

    it("returns failed (does not throw) on a non-2xx response", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "bad token" }), { status: 401 }));
        const result = await redditConversionsService.send(input);
        expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("401") });
    });

    it("returns failed (does not throw) on a network error", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNRESET"));
        expect(await redditConversionsService.send(input)).toEqual({ status: "failed", error: "ECONNRESET" });
    });
});
