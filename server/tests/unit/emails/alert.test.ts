import { describe, it, expect } from "vitest";
import { renderAlertEmail, renderTestAlertEmail } from "../../../src/cloud/alerting/alert-email.js";
import { alertSubject, renderAlertSlack } from "../../../src/lib/alert-message.js";
import type { AlertItem } from "../../../src/lib/alert-batch.js";

const item = (over: Partial<AlertItem> = {}): AlertItem => ({
    vulnId: "CVE-2026-1000",
    reason: "new-critical",
    severityLevel: "critical",
    kevListed: false,
    riskScore: 71,
    packages: ["openssl@3.0.11"],
    fixedVersion: "3.0.12",
    images: [
        {
            imageId: "11111111-1111-4111-8111-111111111111",
            repository: "ghcr.io/acme/api",
            digest: null,
            clusterId: "c1",
            containerCount: 4,
            containers: ["default/api", "payments/worker"],
        },
    ],
    imageCount: 1,
    clusterIds: ["c1"],
    eventIds: ["e1"],
    ...over,
});

const base = {
    orgName: "Acme <Ops>",
    clusterNames: { c1: "prod-eu", c2: "staging" },
    appUrl: "https://app.test",
    settingsUrl: "https://app.test/org-settings?tab=notifications",
    unsubscribeUrl: "https://api.test/v1/alerts/unsubscribe?token=abc.def",
};

describe("alert subject", () => {
    it("names a single advisory and counts several", () => {
        expect(alertSubject({ orgName: "Acme", items: [item()] })).toBe(
            "Critical: CVE-2026-1000 on 1 running image in Acme",
        );
        expect(alertSubject({ orgName: "Acme", items: [item({ kevListed: true, imageCount: 3 })] })).toBe(
            "Known exploited: CVE-2026-1000 on 3 running images in Acme",
        );
        expect(alertSubject({ orgName: "Acme", items: [item(), item({ vulnId: "CVE-2", kevListed: true })] })).toBe(
            "2 new findings, 1 known exploited on running images in Acme",
        );
        expect(alertSubject({ orgName: "Acme", items: [item(), item({ vulnId: "CVE-2" })] })).toBe(
            "2 new critical findings on running images in Acme",
        );
    });
});

describe("renderAlertEmail", () => {
    it("says the advisory, the reason, the packages and where it runs, and links the vulnerability page", () => {
        const mail = renderAlertEmail({ ...base, items: [item({ imageCount: 12 })] });
        expect(mail.text).toContain("CVE-2026-1000 — critical — 71/100 — new critical finding");
        expect(mail.text).toContain("openssl@3.0.11 — fixed in 3.0.12");
        expect(mail.text).toContain("12 running images in prod-eu:");
        expect(mail.text).toContain("ghcr.io/acme/api (prod-eu, default/api, payments/worker, 4 containers)");
        expect(mail.text).toContain("… and 11 more");
        expect(mail.text).toContain("https://app.test/vulnerabilities/CVE-2026-1000");
        expect(mail.text).toContain(base.settingsUrl);
        expect(mail.text).toContain(
            "Unsubscribe (switches alert email off for the whole organisation): https://api.test/v1/alerts/unsubscribe?token=abc.def",
        );
        // The unsubscribe link sits in the layout footer, where mail clients look for one.
        expect(mail.html).toContain('<a href="https://api.test/v1/alerts/unsubscribe?token=abc.def"');
        expect(mail.html).not.toContain("someone used StackRadar to contact this address");
        // HTML escapes what the tenant named.
        expect(mail.html).toContain("Acme &lt;Ops&gt;");
        expect(mail.html).not.toContain("Acme <Ops>");
        expect(mail.html).toContain('href="https://app.test/images/11111111-1111-4111-8111-111111111111"');
    });

    it("phrases a KEV listing as the catalogue changing, not a finding arriving", () => {
        const mail = renderAlertEmail({
            ...base,
            items: [item({ reason: "kev-listed", kevListed: true, severityLevel: "high" })],
        });
        expect(mail.text).toContain(
            "CVE-2026-1000 — high, on CISA KEV — 71/100 — CISA added it to the Known Exploited Vulnerabilities catalogue; it was already running",
        );
    });
});

describe("renderAlertSlack", () => {
    it("is one mrkdwn message with a link per advisory and Slack's three characters escaped", () => {
        const text = renderAlertSlack({ ...base, items: [item({ packages: ["a<b>&c@1"] })] });
        expect(text).toContain(":rotating_light: *Critical: CVE-2026-1000 on 1 running image in Acme &lt;Ops&gt;*");
        expect(text).toContain(
            "*<https://app.test/vulnerabilities/CVE-2026-1000|CVE-2026-1000>* · critical · 71/100 — new critical finding",
        );
        expect(text).toContain("a&lt;b&gt;&amp;c@1 → fixed in 3.0.12");
        expect(text).toContain("1 running image in prod-eu: `ghcr.io/acme/api` (default/api, payments/worker)");
    });
});

describe("renderTestAlertEmail", () => {
    it("proves the channel and promises nothing about findings", () => {
        const mail = renderTestAlertEmail({
            orgName: "Acme",
            settingsUrl: base.settingsUrl,
            unsubscribeUrl: base.unsubscribeUrl,
        });
        expect(mail.subject).toBe("Test alert from StackRadar for Acme");
        expect(mail.text).toContain("the email channel works");
    });
});
