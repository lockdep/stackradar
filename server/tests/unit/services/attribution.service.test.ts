import { describe, it, expect, vi, beforeEach } from "vitest";

const { repo, posthog, reddit, founder, orgRepo, userRepo, clusterRepo } = vi.hoisted(() => ({
    repo: {
        create: vi.fn(),
        findPendingClusterEvents: vi.fn(),
        markSignupEventSent: vi.fn(),
        markClusterEventSent: vi.fn(),
        markAnalyticsSignupSent: vi.fn(),
        markAnalyticsClusterSent: vi.fn(),
        markFounderSignupAlertSent: vi.fn(),
        markFounderClusterAlertSent: vi.fn(),
    },
    posthog: { capture: vi.fn() },
    reddit: { send: vi.fn() },
    founder: { isConfigured: vi.fn(), notifySignup: vi.fn(), notifyFirstCluster: vi.fn() },
    orgRepo: { getOrganizationById: vi.fn() },
    userRepo: { getUserById: vi.fn() },
    clusterRepo: { findById: vi.fn() },
}));
vi.mock("../../../src/cloud/attribution/attribution.repository.js", () => ({ attributionRepository: repo }));
vi.mock("../../../src/repositories/organization.repository.js", () => ({ organizationRepository: orgRepo }));
vi.mock("../../../src/repositories/user.repository.js", () => ({ userRepository: userRepo }));
vi.mock("../../../src/repositories/cluster.repository.js", () => ({ clusterRepository: clusterRepo }));
vi.mock("../../../src/services/posthog.service.js", () => ({ posthogService: posthog }));
vi.mock("../../../src/cloud/attribution/reddit-conversions.service.js", () => ({ redditConversionsService: reddit }));
vi.mock("../../../src/cloud/attribution/founder-alert.service.js", () => ({ founderAlertService: founder }));
vi.mock("../../../src/config/index.js", () => ({ config: { appUrl: "https://app.test" } }));
vi.mock("../../../src/lib/logger.js", () => {
    const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { logger: { child: () => noop }, createLogger: () => noop };
});

import { attributionService } from "../../../src/cloud/attribution/attribution.service.js";

const createdAt = new Date("2026-09-26T08:00:00Z");
const baseRow = {
    userId: "user-1",
    orgId: "org-1",
    clickId: null as string | null,
    utmSource: null as string | null,
    utmMedium: null as string | null,
    utmCampaign: null as string | null,
    utmContent: null as string | null,
    utmTerm: null as string | null,
    timezone: null as string | null,
    locale: null as string | null,
    createdAt,
    signupEventSentAt: null as Date | null,
    clusterEventSentAt: null as Date | null,
    analyticsSignupSentAt: null as Date | null,
    analyticsClusterSentAt: null as Date | null,
    founderSignupAlertSentAt: null as Date | null,
    founderClusterAlertSentAt: null as Date | null,
};
const identity = {
    user: { id: "user-1", email: "ola@example.com", name: "Ola Nordmann" },
    org: { id: "org-1", name: "Ola's Organization" },
};
const report = {
    clusterId: "cluster-1",
    accepted: { namespaces: 3, workloads: 12, containers: 15 },
    scannerVersion: "0.4.1",
};

/** The sends are fire-and-forget; let their promise chains settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    for (const fn of [
        ...Object.values(repo),
        ...Object.values(founder),
        posthog.capture,
        reddit.send,
        orgRepo.getOrganizationById,
        userRepo.getUserById,
        clusterRepo.findById,
    ])
        fn.mockReset();
    posthog.capture.mockResolvedValue({ status: "sent" });
    reddit.send.mockResolvedValue({ status: "sent" });
    founder.isConfigured.mockReturnValue(true);
    founder.notifySignup.mockResolvedValue({ status: "sent", channels: ["email"] });
    founder.notifyFirstCluster.mockResolvedValue({ status: "sent", channels: ["email"] });
    orgRepo.getOrganizationById.mockResolvedValue({ id: "org-1", name: "Ola's Organization" });
    userRepo.getUserById.mockResolvedValue({ id: "user-1", email: "ola@example.com", name: "Ola Nordmann" });
    clusterRepo.findById.mockResolvedValue({ id: "cluster-1", name: "prod-eu" });
    for (const fn of [
        repo.markSignupEventSent,
        repo.markClusterEventSent,
        repo.markAnalyticsSignupSent,
        repo.markAnalyticsClusterSent,
        repo.markFounderSignupAlertSent,
        repo.markFounderClusterAlertSent,
    ]) {
        fn.mockResolvedValue(undefined);
    }
});

describe("attributionService.recordSignup", () => {
    it("sends signup_completed to PostHog for an organic sign-up and no ad conversion", async () => {
        repo.create.mockResolvedValue({ ...baseRow, timezone: "Europe/Oslo", locale: "nb-NO" });

        await attributionService.recordSignup(identity, { timezone: "Europe/Oslo", locale: "nb-NO" });
        await settle();

        expect(repo.create).toHaveBeenCalledWith("user-1", "org-1", { timezone: "Europe/Oslo", locale: "nb-NO" });
        expect(posthog.capture).toHaveBeenCalledTimes(1);
        expect(posthog.capture.mock.calls[0]![0]).toMatchObject({
            event: "signup_completed",
            distinctId: "org-1",
            timestamp: createdAt,
            properties: {
                org_id: "org-1",
                utm_source: null,
                ad_network: null,
                timezone: "Europe/Oslo",
                locale: "nb-NO",
            },
            setOnce: { signup_at: "2026-09-26T08:00:00.000Z", ad_network: null },
        });
        expect(repo.markAnalyticsSignupSent).toHaveBeenCalledWith("user-1");
        expect(reddit.send).not.toHaveBeenCalled();
        expect(repo.markSignupEventSent).not.toHaveBeenCalled();
    });

    it("alerts the founder with the person, the org and where they are, and stamps it", async () => {
        repo.create.mockResolvedValue({ ...baseRow, timezone: "Europe/Oslo", locale: "nb-NO", utmSource: "hn" });

        await attributionService.recordSignup(identity, {});
        await settle();

        expect(founder.notifySignup).toHaveBeenCalledTimes(1);
        expect(founder.notifySignup.mock.calls[0]![0]).toEqual({
            person: { email: "ola@example.com", name: "Ola Nordmann" },
            org: { id: "org-1", name: "Ola's Organization" },
            origin: {
                timezone: "Europe/Oslo",
                locale: "nb-NO",
                utmSource: "hn",
                utmMedium: null,
                utmCampaign: null,
                utmContent: null,
                adNetwork: null,
            },
            signedUpAt: createdAt,
            adminUrl: "https://app.test/admin",
        });
        expect(repo.markFounderSignupAlertSent).toHaveBeenCalledWith("user-1");
    });

    it("does not stamp a founder alert no channel accepted", async () => {
        repo.create.mockResolvedValue({ ...baseRow });
        founder.notifySignup.mockResolvedValue({ status: "not_configured" });

        await attributionService.recordSignup(identity, {});
        await settle();

        expect(repo.markFounderSignupAlertSent).not.toHaveBeenCalled();
        // The other receivers are unaffected.
        expect(repo.markAnalyticsSignupSent).toHaveBeenCalledWith("user-1");
    });

    it("sends both the analytics event and the Reddit conversion for an ad-click sign-up", async () => {
        repo.create.mockResolvedValue({ ...baseRow, clickId: "rdt-1", utmSource: "reddit", utmCampaign: "europe" });

        await attributionService.recordSignup(identity, {
            clickId: "rdt-1",
            utmSource: "reddit",
            utmCampaign: "europe",
        });
        await settle();

        const captured = posthog.capture.mock.calls[0]![0];
        expect(captured.properties).toMatchObject({
            utm_source: "reddit",
            utm_campaign: "europe",
            ad_network: "reddit",
        });
        // The click id is the network's key and never goes to PostHog, and
        // the founder alert names the network, not the click.
        expect(JSON.stringify(captured)).not.toContain("rdt-1");
        expect(JSON.stringify(founder.notifySignup.mock.calls[0]![0])).not.toContain("rdt-1");
        expect(founder.notifySignup.mock.calls[0]![0].origin.adNetwork).toBe("reddit");
        expect(reddit.send).toHaveBeenCalledWith({
            trackingType: "SIGN_UP",
            clickId: "rdt-1",
            conversionId: "signup:user-1",
            eventAt: createdAt,
        });
        expect(repo.markSignupEventSent).toHaveBeenCalledWith("user-1");
    });

    it("does not stamp a send the receiver did not accept", async () => {
        repo.create.mockResolvedValue({ ...baseRow });
        posthog.capture.mockResolvedValue({ status: "failed", error: "503" });

        await attributionService.recordSignup(identity, {});
        await settle();

        expect(repo.markAnalyticsSignupSent).not.toHaveBeenCalled();
    });

    it("sends nothing when the row already existed (setup re-posted)", async () => {
        repo.create.mockResolvedValue(undefined);

        await attributionService.recordSignup(identity, {});
        await settle();

        expect(posthog.capture).not.toHaveBeenCalled();
        expect(founder.notifySignup).not.toHaveBeenCalled();
        expect(reddit.send).not.toHaveBeenCalled();
    });

    it("never throws when the insert fails", async () => {
        repo.create.mockRejectedValue(new Error("db down"));
        await expect(attributionService.recordSignup(identity, {})).resolves.toBeUndefined();
    });

    it("never throws when the founder alert itself rejects", async () => {
        repo.create.mockResolvedValue({ ...baseRow });
        founder.notifySignup.mockRejectedValue(new Error("boom"));
        await expect(attributionService.recordSignup(identity, {})).resolves.toBeUndefined();
        await settle();
        expect(repo.markFounderSignupAlertSent).not.toHaveBeenCalled();
    });
});

describe("attributionService.onClusterReported", () => {
    it("sends first_sbom_received once with the time since sign-up, and no ad conversion without a click id", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-26T20:30:00Z"));
        try {
            repo.findPendingClusterEvents.mockResolvedValue([{ ...baseRow, utmSource: "hn" }]);

            await attributionService.onClusterReported("org-1", report);

            expect(posthog.capture).toHaveBeenCalledTimes(1);
            expect(posthog.capture.mock.calls[0]![0]).toMatchObject({
                event: "first_sbom_received",
                distinctId: "org-1",
                properties: { org_id: "org-1", utm_source: "hn", ad_network: null, hours_since_signup: 12.5 },
            });
            expect(repo.markAnalyticsClusterSent).toHaveBeenCalledWith("user-1");
            expect(reddit.send).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("alerts the founder with the org, the cluster, the report and the person, then stamps it", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-26T20:30:00Z"));
        try {
            repo.findPendingClusterEvents.mockResolvedValue([{ ...baseRow, timezone: "Europe/Oslo" }]);

            await attributionService.onClusterReported("org-1", report);

            expect(orgRepo.getOrganizationById).toHaveBeenCalledWith("org-1");
            expect(userRepo.getUserById).toHaveBeenCalledWith("user-1");
            expect(clusterRepo.findById).toHaveBeenCalledWith("cluster-1", "org-1");
            expect(founder.notifyFirstCluster).toHaveBeenCalledTimes(1);
            expect(founder.notifyFirstCluster.mock.calls[0]![0]).toMatchObject({
                person: { email: "ola@example.com", name: "Ola Nordmann" },
                org: { id: "org-1", name: "Ola's Organization" },
                cluster: { id: "cluster-1", name: "prod-eu" },
                accepted: { namespaces: 3, workloads: 12, containers: 15 },
                scannerVersion: "0.4.1",
                hoursSinceSignup: 12.5,
                origin: { timezone: "Europe/Oslo", adNetwork: null },
                adminUrl: "https://app.test/admin",
            });
            expect(repo.markFounderClusterAlertSent).toHaveBeenCalledWith("user-1");
        } finally {
            vi.useRealTimers();
        }
    });

    it("skips the founder alert, and its lookups, when alerts are not configured or already stamped", async () => {
        founder.isConfigured.mockReturnValue(false);
        repo.findPendingClusterEvents.mockResolvedValue([{ ...baseRow }]);
        await attributionService.onClusterReported("org-1", report);
        expect(founder.notifyFirstCluster).not.toHaveBeenCalled();
        expect(orgRepo.getOrganizationById).not.toHaveBeenCalled();
        // The analytics event still goes.
        expect(posthog.capture).toHaveBeenCalledTimes(1);

        founder.isConfigured.mockReturnValue(true);
        repo.findPendingClusterEvents.mockResolvedValue([{ ...baseRow, founderClusterAlertSentAt: new Date() }]);
        await attributionService.onClusterReported("org-1", report);
        expect(founder.notifyFirstCluster).not.toHaveBeenCalled();
    });

    it("falls back to the cluster id when the cluster row is gone, and skips when the user is", async () => {
        repo.findPendingClusterEvents.mockResolvedValue([{ ...baseRow }]);
        clusterRepo.findById.mockResolvedValue(undefined);
        await attributionService.onClusterReported("org-1", report);
        expect(founder.notifyFirstCluster.mock.calls[0]![0].cluster).toEqual({ id: "cluster-1", name: "cluster-1" });

        founder.notifyFirstCluster.mockClear();
        userRepo.getUserById.mockResolvedValue(null);
        await attributionService.onClusterReported("org-1", report);
        expect(founder.notifyFirstCluster).not.toHaveBeenCalled();
        expect(repo.markFounderClusterAlertSent).toHaveBeenCalledTimes(1);
    });

    it("reports the Reddit LEAD for a click-id row and skips receivers already stamped", async () => {
        repo.findPendingClusterEvents.mockResolvedValue([
            { ...baseRow, clickId: "rdt-1", analyticsClusterSentAt: new Date(), founderClusterAlertSentAt: new Date() },
        ]);

        await attributionService.onClusterReported("org-1", report);

        expect(posthog.capture).not.toHaveBeenCalled();
        expect(founder.notifyFirstCluster).not.toHaveBeenCalled();
        expect(reddit.send).toHaveBeenCalledWith({
            trackingType: "LEAD",
            clickId: "rdt-1",
            conversionId: "cluster:user-1",
        });
        expect(repo.markClusterEventSent).toHaveBeenCalledWith("user-1");
    });

    it("skips the Reddit send when only the analytics event is owed", async () => {
        repo.findPendingClusterEvents.mockResolvedValue([
            { ...baseRow, clickId: "rdt-1", clusterEventSentAt: new Date(), founderClusterAlertSentAt: new Date() },
        ]);

        await attributionService.onClusterReported("org-1", report);

        expect(posthog.capture).toHaveBeenCalledTimes(1);
        expect(reddit.send).not.toHaveBeenCalled();
    });

    it("does nothing for an org with no pending rows", async () => {
        repo.findPendingClusterEvents.mockResolvedValue([]);
        await attributionService.onClusterReported("org-1", report);
        expect(posthog.capture).not.toHaveBeenCalled();
        expect(founder.notifyFirstCluster).not.toHaveBeenCalled();
        expect(reddit.send).not.toHaveBeenCalled();
    });

    it("never throws when the lookup fails", async () => {
        repo.findPendingClusterEvents.mockRejectedValue(new Error("db down"));
        await expect(attributionService.onClusterReported("org-1", report)).resolves.toBeUndefined();
    });
});
