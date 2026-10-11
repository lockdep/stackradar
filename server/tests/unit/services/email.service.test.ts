import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        email: { resendApiKey: "", webhookSecret: "", from: "StackRadar <no-reply@mail.test>", replyTo: "" },
    },
}));
vi.mock("../../../src/config/index.js", () => ({ config: mockConfig }));
vi.mock("../../../src/lib/logger.js", () => {
    const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { logger: { child: () => noop }, createLogger: () => noop };
});

import { emailService } from "../../../src/cloud/email/email.service.js";

const input = { to: "a@b.test", subject: "Hi", html: "<p>hi</p>", text: "hi" };

describe("emailService.send", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        mockConfig.email.resendApiKey = "re_test";
        mockConfig.email.replyTo = "";
    });
    afterEach(() => vi.unstubAllGlobals());

    it("returns not_configured without calling Resend when no API key is set", async () => {
        mockConfig.email.resendApiKey = "";
        expect(await emailService.send(input)).toEqual({ status: "not_configured" });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(emailService.isConfigured()).toBe(false);
    });

    it("lets a message override the configured Reply-To", async () => {
        mockConfig.email.replyTo = "support@test";
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "msg_2" }), { status: 200 }));

        await emailService.send({ ...input, replyTo: "person@example.com" });

        expect(JSON.parse(fetchMock.mock.calls[0]![1].body).reply_to).toBe("person@example.com");
    });

    it("POSTs to Resend with auth, idempotency key and tags, and returns the message id", async () => {
        mockConfig.email.replyTo = "support@test";
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));

        const result = await emailService.send({ ...input, idempotencyKey: "k1", tags: { type: "org_invite" } });

        expect(result).toEqual({ status: "sent", messageId: "msg_1" });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://api.resend.com/emails");
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({ Authorization: "Bearer re_test", "Idempotency-Key": "k1" });
        expect(JSON.parse(init.body)).toEqual({
            from: "StackRadar <no-reply@mail.test>",
            to: ["a@b.test"],
            subject: "Hi",
            html: "<p>hi</p>",
            text: "hi",
            reply_to: "support@test",
            tags: [{ name: "type", value: "org_invite" }],
        });
    });

    it("returns failed (does not throw) on a non-2xx response", async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "invalid from" }), { status: 422 }));
        const result = await emailService.send(input);
        expect(result.status).toBe("failed");
        expect(result).toMatchObject({ error: expect.stringContaining("422") });
    });

    it("returns failed when the response has no id", async () => {
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        expect(await emailService.send(input)).toMatchObject({ status: "failed" });
    });

    it("returns failed (does not throw) on a network error", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNRESET"));
        expect(await emailService.send(input)).toEqual({ status: "failed", error: "ECONNRESET" });
    });
});
