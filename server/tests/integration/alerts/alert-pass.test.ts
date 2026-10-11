/**
 * The critical & KEV alert pass (`services/alert.service.ts`): who is
 * visited, what is sent, when the debounce holds, and what is written down.
 * Email and the Slack POST are the two side effects and both are mocked at
 * their module boundary; everything else is the real database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createUser,
    addOrgMember,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { ActivityEventType } from "../../../src/db/schema/remediation.js";
import type { SendEmailInput, SendEmailResult } from "../../../src/cloud/email/email.service.js";

// Hoisted above the static imports: `src/config` snapshots the environment
// the moment something in the import graph loads it.
vi.hoisted(() => {
    process.env.PUBLIC_API_URL = "https://api.test";
    process.env.DIGEST_UNSUBSCRIBE_SECRET = "alerts-secret";
});

vi.mock("../../../src/lib/slack-webhook.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../../src/lib/slack-webhook.js")>();
    return { ...original, postSlackWebhook: vi.fn(async () => ({ status: "sent" as const })) };
});

async function alertService() {
    return (await import("../../../src/services/alert.service.js")).alertService;
}
async function emailService() {
    return (await import("../../../src/cloud/email/email.service.js")).emailService;
}
async function slack() {
    return (await import("../../../src/lib/slack-webhook.js")).postSlackWebhook as unknown as ReturnType<typeof vi.fn>;
}

const MIN = 60_000;
const OPTS = { quietMs: 10 * MIN, maxDelayMs: 60 * MIN };

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("alert pass", () => {
    let pro: CreateOrgWithOwnerResult;
    let clusterId: string;
    let sendSpy: MockInstance<(input: SendEmailInput) => Promise<SendEmailResult>>;

    beforeAll(async () => {
        // No app is built here, so the cloud's email channel is registered
        // the way the worker does it.
        (await import("../../../src/cloud/index.js")).enableCloud();
        const email = await emailService();
        vi.spyOn(email, "isConfigured").mockReturnValue(true);
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        pro = await createOrgWithOwner(db, { email: "owner@acme.test" }, { plan: "pro", name: "Acme" });
        const admin = await createUser(db, { email: "admin@acme.test" });
        await addOrgMember(db, admin.id, pro.org.id, "admin");
        const member = await createUser(db, { email: "member@acme.test" });
        await addOrgMember(db, member.id, pro.org.id, "member");
        clusterId = (await createCluster(db, pro.org.id, { name: "prod-eu" })).id;
        const email = await emailService();
        sendSpy = vi.spyOn(email, "send").mockResolvedValue({ status: "sent", messageId: "msg-1" });
        (await slack()).mockClear();
    });

    afterEach(() => {
        sendSpy.mockRestore();
    });

    async function setCursor(orgId: string, ageMs: number) {
        await getTestDb()
            .update(schema.organizations)
            .set({ alertsCursorAt: new Date(Date.now() - ageMs) })
            .where(eq(schema.organizations.id, orgId));
    }

    async function event(orgId: string, type: ActivityEventType, ageMs: number, payload: Record<string, unknown>) {
        const [row] = await getTestDb()
            .insert(schema.activityEvents)
            .values({ orgId, clusterId, type, payload, createdAt: new Date(Date.now() - ageMs) })
            .returning();
        return row!;
    }

    const criticalScan = (vulnId: string, repository = "ghcr.io/acme/api") => ({
        cause: "mirror",
        repository,
        digest: "sha256:abc",
        containerCount: 2,
        containers: [{ namespace: "default", workloadName: "api", workloadKind: "Deployment", init: false }],
        added: [
            {
                vulnId,
                packageName: "openssl",
                packageVersion: "3.0.11",
                severityLevel: "critical",
                riskScore: 71,
                kevListed: false,
                fixedVersion: "3.0.12",
            },
        ],
        rescored: [],
    });

    it("seeds the cursor on the first pass and sends nothing for what came before", async () => {
        await event(pro.org.id, "scan.findings-changed", 30 * MIN, criticalScan("CVE-2026-1"));

        const stats = await (await alertService()).runPass(new Date(), OPTS);

        expect(stats).toMatchObject({ orgs: 1, started: 1, messages: 0 });
        expect(sendSpy).not.toHaveBeenCalled();
        const [org] = await getTestDb()
            .select()
            .from(schema.organizations)
            .where(eq(schema.organizations.id, pro.org.id));
        expect(org!.alertsCursorAt).not.toBeNull();
    });

    it("sends one email per owner and admin, grouped by advisory, and records each send", async () => {
        await setCursor(pro.org.id, 2 * 60 * MIN);
        const a = await event(
            pro.org.id,
            "scan.findings-changed",
            40 * MIN,
            criticalScan("CVE-2026-1", "ghcr.io/acme/api"),
        );
        const b = await event(
            pro.org.id,
            "scan.findings-changed",
            35 * MIN,
            criticalScan("CVE-2026-1", "ghcr.io/acme/web"),
        );
        await event(pro.org.id, "scan.findings-changed", 30 * MIN, {
            ...criticalScan("CVE-2026-9"),
            cause: "first-scan",
        });
        await event(pro.org.id, "container.appeared", 30 * MIN, {});

        const stats = await (await alertService()).runPass(new Date(), OPTS);

        expect(stats).toMatchObject({ orgs: 1, messages: 2, failed: 0, advisories: 1 });
        expect(sendSpy).toHaveBeenCalledTimes(2);
        const recipients = sendSpy.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
        expect(recipients).toEqual(["admin@acme.test", "owner@acme.test"]);
        const mail = sendSpy.mock.calls[0]![0];
        expect(mail.subject).toBe("Critical: CVE-2026-1 on 2 running images in Acme");
        // Deliverability: a session-less unsubscribe link, in the footer and in the one-click headers.
        expect(mail.text).toMatch(/https:\/\/api\.test\/v1\/alerts\/unsubscribe\?token=/);
        expect(mail.headers?.["List-Unsubscribe"]).toMatch(
            /^<https:\/\/api\.test\/v1\/alerts\/unsubscribe\?token=.+>$/,
        );
        expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        expect(mail.text).toContain("ghcr.io/acme/api (prod-eu, default/api, 2 containers)");
        expect(mail.text).toContain("ghcr.io/acme/web (prod-eu, default/api, 2 containers)");
        expect(mail.idempotencyKey).toContain(`alert/${pro.org.id}/`);

        const sends = await getTestDb().select().from(schema.alertSends).where(eq(schema.alertSends.orgId, pro.org.id));
        expect(sends).toHaveLength(2);
        expect(sends[0]!.eventIds.sort()).toEqual([a.id, b.id].sort());
        expect(sends[0]!.advisoryCount).toBe(1);
        expect(sends[0]!.status).toBe("sent");
        expect(sends[0]!.resendMessageId).toBe("msg-1");
        expect((await slack()).mock.calls).toHaveLength(0);

        // Cursor moved past the batch: a second pass has nothing to say.
        const again = await (await alertService()).runPass(new Date(), OPTS);
        expect(again.messages).toBe(0);
    });

    it("posts to the org's Slack webhook through the SSRF guard, and only Slack when email is off", async () => {
        await setCursor(pro.org.id, 2 * 60 * MIN);
        await getTestDb()
            .update(schema.organizations)
            .set({
                alertEmailEnabled: false,
                alertSlackWebhookUrl: "https://hooks.slack.com/services/T000/B000/XXXXYYYY",
            })
            .where(eq(schema.organizations.id, pro.org.id));
        await event(pro.org.id, "finding.kev-listed", 30 * MIN, {
            vulnId: "CVE-2026-5",
            severityLevel: "high",
            riskScore: 90,
            packages: ["glibc@2.36"],
            imageCount: 1,
            images: [
                {
                    imageId: null,
                    repository: "ghcr.io/acme/db",
                    digest: null,
                    clusterId,
                    containerCount: 3,
                    containers: [{ namespace: "data", workloadName: "pg" }],
                },
            ],
        });

        const stats = await (await alertService()).runPass(new Date(), OPTS);

        expect(stats.messages).toBe(1);
        expect(sendSpy).not.toHaveBeenCalled();
        const post = await slack();
        expect(post).toHaveBeenCalledTimes(1);
        const [url, text, opts] = post.mock.calls[0]!;
        expect(url).toBe("https://hooks.slack.com/services/T000/B000/XXXXYYYY");
        expect(text).toContain("Known exploited: CVE-2026-5 on 1 running image in Acme");
        expect(text).toContain("CISA added it to the Known Exploited Vulnerabilities catalogue");
        expect(opts).toEqual({ untrusted: true });
        const [send] = await getTestDb().select().from(schema.alertSends);
        expect(send).toMatchObject({ channel: "slack", recipient: "hooks.slack.com/…YYYY", status: "sent" });
    });

    it("waits while a burst is still going, then sends when it goes quiet or has waited long enough", async () => {
        await setCursor(pro.org.id, 2 * 60 * MIN);
        await event(pro.org.id, "scan.findings-changed", 15 * MIN, criticalScan("CVE-2026-1", "ghcr.io/acme/a"));
        await event(pro.org.id, "scan.findings-changed", 2 * MIN, criticalScan("CVE-2026-1", "ghcr.io/acme/b"));

        const service = await alertService();
        const first = await service.runPass(new Date(), OPTS);
        expect(first).toMatchObject({ waiting: 1, messages: 0 });
        expect(sendSpy).not.toHaveBeenCalled();

        // Twelve minutes later nothing new landed: both images ride in one message.
        const later = new Date(Date.now() + 12 * MIN);
        const second = await service.runPass(later, OPTS);
        expect(second).toMatchObject({ waiting: 0, messages: 2, advisories: 1 });
        expect(sendSpy.mock.calls[0]![0].subject).toBe("Critical: CVE-2026-1 on 2 running images in Acme");
    });

    it("stops waiting once the oldest pending event has waited the maximum", async () => {
        await setCursor(pro.org.id, 3 * 60 * MIN);
        await event(pro.org.id, "scan.findings-changed", 61 * MIN, criticalScan("CVE-2026-1", "ghcr.io/acme/a"));
        await event(pro.org.id, "scan.findings-changed", 1 * MIN, criticalScan("CVE-2026-1", "ghcr.io/acme/b"));

        const stats = await (await alertService()).runPass(new Date(), OPTS);
        expect(stats.messages).toBe(2);
        // Only the settled event is in this message; the fresh one waits for the next.
        expect(sendSpy.mock.calls[0]![0].subject).toBe("Critical: CVE-2026-1 on 1 running image in Acme");
    });

    it("applies the org's own criteria — a high floor alerts on a high, KEV off ignores a listing", async () => {
        await setCursor(pro.org.id, 2 * 60 * MIN);
        await getTestDb()
            .update(schema.organizations)
            .set({ alertMinSeverity: "high", alertKev: false })
            .where(eq(schema.organizations.id, pro.org.id));
        const high = criticalScan("CVE-2026-8");
        (high.added[0] as { severityLevel: string }).severityLevel = "high";
        await event(pro.org.id, "scan.findings-changed", 30 * MIN, high);
        await event(pro.org.id, "finding.kev-listed", 30 * MIN, {
            vulnId: "CVE-2026-9",
            images: [],
            imageCount: 0,
            packages: [],
        });

        const stats = await (await alertService()).runPass(new Date(), OPTS);

        expect(stats).toMatchObject({ messages: 2, advisories: 1 });
        expect(sendSpy.mock.calls[0]![0].subject).toBe("Critical: CVE-2026-8 on 1 running image in Acme");
        expect(sendSpy.mock.calls[0]![0].text).not.toContain("CVE-2026-9");
    });

    it("never visits a free org, even with events and a webhook set", async () => {
        const db = getTestDb();
        const free = await createOrgWithOwner(db, { email: "free@acme.test" }, { plan: "free" });
        await db
            .update(schema.organizations)
            .set({
                alertsCursorAt: new Date(Date.now() - 2 * 60 * MIN),
                alertSlackWebhookUrl: "https://hooks.slack.com/services/T/B/C",
            })
            .where(eq(schema.organizations.id, free.org.id));
        const freeCluster = await createCluster(db, free.org.id, { name: "free-cluster" });
        await db.insert(schema.activityEvents).values({
            orgId: free.org.id,
            clusterId: freeCluster.id,
            type: "scan.findings-changed",
            payload: criticalScan("CVE-2026-1"),
            createdAt: new Date(Date.now() - 30 * MIN),
        });

        const stats = await (await alertService()).runPass(new Date(), OPTS);

        // Only the pro org was visited (and it has no cursor yet).
        expect(stats.orgs).toBe(1);
        expect(sendSpy).not.toHaveBeenCalled();
        expect((await slack()).mock.calls).toHaveLength(0);
    });

    it("records a failed Slack post with the channel's own words and carries on", async () => {
        await setCursor(pro.org.id, 2 * 60 * MIN);
        await getTestDb()
            .update(schema.organizations)
            .set({ alertSlackWebhookUrl: "https://hooks.slack.com/services/T000/B000/XXXXYYYY" })
            .where(eq(schema.organizations.id, pro.org.id));
        (await slack()).mockResolvedValueOnce({ status: "failed", error: "Webhook responded 404: no_service" });
        await event(pro.org.id, "scan.findings-changed", 30 * MIN, criticalScan("CVE-2026-1"));

        const stats = await (await alertService()).runPass(new Date(), OPTS);

        expect(stats).toMatchObject({ messages: 2, failed: 1 });
        const sends = await getTestDb().select().from(schema.alertSends).where(eq(schema.alertSends.channel, "slack"));
        expect(sends[0]).toMatchObject({ status: "failed", error: "Webhook responded 404: no_service" });
    });
});
