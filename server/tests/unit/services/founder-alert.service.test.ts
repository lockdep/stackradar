import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, email } = vi.hoisted(() => ({
    mockConfig: {
        email: { resendApiKey: "re_test" },
        founderAlerts: { email: "", slackWebhookUrl: "" },
    },
    email: { isConfigured: vi.fn(), send: vi.fn() },
}));
vi.mock("../../../src/config/index.js", () => ({ config: mockConfig }));
vi.mock("../../../src/cloud/email/email.service.js", () => ({ emailService: email }));
vi.mock("../../../src/lib/logger.js", () => {
    const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { logger: { child: () => noop }, createLogger: () => noop };
});

import { founderAlertService } from "../../../src/cloud/attribution/founder-alert.service.js";

const origin = {
    timezone: "Europe/Oslo",
    locale: "nb-NO",
    utmSource: "reddit",
    utmMedium: "cpc",
    utmCampaign: "k8s-a4",
    utmContent: null,
    adNetwork: "reddit",
};
const signup = {
    person: { email: "ola@example.com", name: "Ola <Nordmann>" },
    org: { id: "org-1", name: "Ola's Organization" },
    origin,
    signedUpAt: new Date("2026-09-26T08:00:00Z"),
    adminUrl: "https://app.test/admin",
};
const cluster = {
    ...signup,
    cluster: { id: "cluster-1", name: "prod-eu" },
    accepted: { namespaces: 3, workloads: 12, containers: 15 },
    scannerVersion: "0.4.1",
    hoursSinceSignup: 12.5,
};

describe("founderAlertService", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        email.isConfigured.mockReset();
        email.send.mockReset();
        email.isConfigured.mockReturnValue(true);
        email.send.mockResolvedValue({ status: "sent", messageId: "msg_1" });
        mockConfig.email.resendApiKey = "re_test";
        mockConfig.founderAlerts.email = "";
        mockConfig.founderAlerts.slackWebhookUrl = "";
    });

    it("is not configured, and sends nothing, with no address and no webhook", async () => {
        expect(founderAlertService.isConfigured()).toBe(false);
        expect(await founderAlertService.notifySignup(signup)).toEqual({ status: "not_configured" });
        expect(email.send).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is not configured when an address is set but email itself is not", () => {
        mockConfig.founderAlerts.email = "founder@test";
        email.isConfigured.mockReturnValue(false);
        expect(founderAlertService.isConfigured()).toBe(false);
    });

    it("emails the sign-up alert to the founder with Reply-To set to the person", async () => {
        mockConfig.founderAlerts.email = "founder@test";

        const result = await founderAlertService.notifySignup(signup);

        expect(result).toEqual({ status: "sent", channels: ["email"] });
        expect(email.send).toHaveBeenCalledTimes(1);
        const sent = email.send.mock.calls[0]![0];
        expect(sent).toMatchObject({
            to: "founder@test",
            replyTo: "ola@example.com",
            subject: "New sign-up: Ola <Nordmann> <ola@example.com> (Europe/Oslo · nb-NO)",
            tags: { type: "founder_alert", kind: "signup" },
            idempotencyKey: "founder-alert/signup/org-1",
        });
        // Every value is user-supplied text and is escaped in the HTML body.
        expect(sent.html).toContain("Ola &lt;Nordmann&gt;");
        expect(sent.html).not.toContain("Ola <Nordmann>");
        expect(sent.html).toContain("Ola&#39;s Organization");
        expect(sent.html).toContain("reddit / cpc / k8s-a4 (reddit ad)");
        expect(sent.text).toContain("Email: ola@example.com");
        expect(sent.text).toContain("Time zone: Europe/Oslo");
        expect(sent.text).toContain("Admin: https://app.test/admin");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("emails the first-cluster alert with the cluster and what it reported", async () => {
        mockConfig.founderAlerts.email = "founder@test";

        const result = await founderAlertService.notifyFirstCluster(cluster);

        expect(result).toEqual({ status: "sent", channels: ["email"] });
        const sent = email.send.mock.calls[0]![0];
        expect(sent).toMatchObject({
            subject: "Cluster connected: Ola's Organization · prod-eu",
            replyTo: "ola@example.com",
            tags: { kind: "cluster" },
            idempotencyKey: "founder-alert/cluster/org-1",
        });
        expect(sent.text).toContain("Reported: 15 containers in 12 workloads across 3 namespaces");
        expect(sent.text).toContain("Scanner: 0.4.1");
        expect(sent.text).toContain("Time since sign-up: 12.5 h");
    });

    it("labels an organic sign-up as such and leaves unknown fields blank", async () => {
        mockConfig.founderAlerts.email = "founder@test";
        await founderAlertService.notifySignup({
            ...signup,
            person: { email: "x@example.com", name: null },
            origin: { timezone: null, locale: null, utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, adNetwork: null },
        });
        const sent = email.send.mock.calls[0]![0];
        expect(sent.subject).toBe("New sign-up: x@example.com");
        expect(sent.text).toContain("Source: organic / direct");
        expect(sent.text).toContain("Time zone: —");
    });

    it("posts to the Slack webhook as mrkdwn, without email when no address is set", async () => {
        mockConfig.founderAlerts.slackWebhookUrl = "https://hooks.slack.test/abc";
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        const result = await founderAlertService.notifyFirstCluster(cluster);

        expect(result).toEqual({ status: "sent", channels: ["slack"] });
        expect(email.send).not.toHaveBeenCalled();
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://hooks.slack.test/abc");
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body);
        expect(body.text).toContain("*Cluster connected:* Ola's Organization · prod-eu");
        expect(body.text).toContain("15 containers, 12 workloads, 3 namespaces");
        expect(body.text).toContain("<https://app.test/admin|Open admin>");
    });

    it("counts as sent when one of two channels accepts, and reports the other's error", async () => {
        mockConfig.founderAlerts.email = "founder@test";
        mockConfig.founderAlerts.slackWebhookUrl = "https://hooks.slack.test/abc";
        fetchMock.mockResolvedValue(new Response("invalid_token", { status: 403 }));

        expect(await founderAlertService.notifySignup(signup)).toEqual({ status: "sent", channels: ["email"] });
    });

    it("fails when every configured channel fails", async () => {
        mockConfig.founderAlerts.email = "founder@test";
        mockConfig.founderAlerts.slackWebhookUrl = "https://hooks.slack.test/abc";
        email.send.mockResolvedValue({ status: "failed", error: "Resend responded 500" });
        fetchMock.mockRejectedValue(new Error("ECONNRESET"));

        const result = await founderAlertService.notifySignup(signup);

        expect(result.status).toBe("failed");
        expect(result.status === "failed" && result.error).toContain("email: Resend responded 500");
        expect(result.status === "failed" && result.error).toContain("slack: ECONNRESET");
    });
});
