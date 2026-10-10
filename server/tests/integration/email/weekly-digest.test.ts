/**
 * The weekly digest (plan item 5b): which orgs and people get it, what it
 * says, the append-only send log the Resend webhook updates, and the
 * signed unsubscribe link.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createUser,
    addOrgMember,
    createCluster,
    createSbom,
    seedRunningImage,
    withFindingIdentity,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { signResendPayload } from "../../../src/cloud/email/resend-webhook.js";

const WEBHOOK_SECRET = "whsec_" + Buffer.from("test-webhook-secret").toString("base64");
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.APP_URL = "https://app.test";
process.env.PUBLIC_API_URL = "https://api.test";
process.env.DIGEST_UNSUBSCRIBE_SECRET = "digest-secret";

const fetchMock = vi.fn();
const DAY = 24 * 60 * 60 * 1000;

function sentMails() {
    return fetchMock.mock.calls.map(([, init]) => ({
        idempotencyKey: init.headers["Idempotency-Key"] as string,
        ...(JSON.parse(init.body) as { to: string[]; subject: string; text: string; html: string; tags: { name: string; value: string }[] }),
    }));
}

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("weekly digest", () => {
    let app: Express;

    beforeAll(async () => {
        vi.stubGlobal("fetch", fetchMock);
        app = await getTestApp();
    });
    afterAll(() => vi.unstubAllGlobals());

    beforeEach(async () => {
        await cleanAllData();
        fetchMock.mockReset();
        let n = 0;
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: `msg_${++n}` }), { status: 200 }));
    });

    /** An org with one scanned image carrying a KEV critical, an owner, an admin and a member. */
    async function seedScannedOrg(orgName = "Acme") {
        const db = getTestDb();
        const { user: owner, org } = await createOrgWithOwner(db, { email: `owner-${orgName}@test.com`, name: "Olivia" }, { name: orgName, plan: "pro" });
        const admin = await createUser(db, { email: `admin-${orgName}@test.com` });
        await addOrgMember(db, admin.id, org.id, "admin");
        const member = await createUser(db, { email: `member-${orgName}@test.com` });
        await addOrgMember(db, member.id, org.id, "member");

        const cluster = await createCluster(db, org.id, { name: "prod" });
        const running = await seedRunningImage(db, org.id, cluster.id, { workloadName: "api", digest: "sha256:" + "a".repeat(64) });
        const sbom = await createSbom(db, { imageId: running.image.id });
        const [component] = await db
            .insert(schema.components)
            .values({ sbomId: sbom.id, name: "lodash", version: "4.17.21", purl: "pkg:npm/lodash@4.17.21", type: "library", isDirect: true })
            .returning();
        /* Advisories are public facts shared by every tenant — one row,
           reused by every org this helper seeds. */
        const [existing] = await db.select().from(schema.vulnerabilities).where(eq(schema.vulnerabilities.vulnId, "CVE-2024-0001"));
        const vuln =
            existing ??
            (
                await db
                    .insert(schema.vulnerabilities)
                    .values(withFindingIdentity([{ vulnId: "CVE-2024-0001", source: "osv", severityLevel: "critical", cvssScore: 9.8, kevListedAt: new Date("2024-01-10T00:00:00Z") }]))
                    .returning()
            )[0];
        await db.insert(schema.componentVulnerabilities).values({
            componentId: component!.id,
            vulnerabilityId: vuln!.id,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
            fixedVersion: "4.17.22",
        });
        return { owner, admin, member, org, cluster, image: running.image };
    }

    it("mails owners and admins of scanned tenant orgs, once each, and logs every send", async () => {
        const { digestService } = await import("../../../src/cloud/alerting/digest.service.js");
        const db = getTestDb();
        const { owner, admin, org, cluster } = await seedScannedOrg();

        // A snapshot from eight days ago gives the delta something to compare with.
        await db.insert(schema.orgMetricsSnapshots).values({
            orgId: org.id,
            capturedAt: new Date(Date.now() - 8 * DAY),
            totalVulnerabilities: 3,
            totalWorkloads: 1,
            totalComponents: 10,
            riskScore: 150,
        });
        await db.insert(schema.activityEvents).values({
            orgId: org.id,
            clusterId: cluster.id,
            type: "scan.findings-changed",
            createdAt: new Date(Date.now() - 2 * DAY),
            payload: {
                cause: "mirror",
                addedBySeverity: { critical: 1, high: 0, medium: 0, low: 0, unscored: 0 },
                added: [{ vulnId: "CVE-2024-0001", severityLevel: "critical", kevListed: true }],
                removed: [],
            },
        });

        // Not mailed: an org with nothing scanned, the demo org, an opted-out org.
        await createOrgWithOwner(db, { email: "empty@test.com" }, { name: "Empty" });
        const demo = await seedScannedOrg("Demo");
        await db.update(schema.organizations).set({ demo: true }).where(eq(schema.organizations.id, demo.org.id));
        const off = await seedScannedOrg("Off");
        await db.update(schema.organizations).set({ weeklyDigestEnabled: false }).where(eq(schema.organizations.id, off.org.id));

        const stats = await digestService.sendWeeklyDigests(new Date("2026-09-14T07:05:00Z"));
        expect(stats).toEqual({ orgs: 1, sent: 2, skipped: 0, failed: 0 });

        const mails = sentMails();
        expect(mails.map((m) => m.to[0]).sort()).toEqual([admin.email, owner.email].sort());
        const ownerMail = mails.find((m) => m.to[0] === owner.email)!;
        expect(ownerMail.idempotencyKey).toBe(`digest/${org.id}/${owner.id}/2026-W38`);
        expect(ownerMail.subject).toContain("Acme: Radar Score");
        expect(ownerMail.subject).toContain("over the week");
        expect(ownerMail.text).toContain("Hi Olivia,");
        expect(ownerMail.text).toContain("CVE-2024-0001");
        expect(ownerMail.text).toContain("lodash@4.17.21");
        expect(ownerMail.text).toContain("on CISA KEV");
        expect(ownerMail.text).toContain("New this week on CISA KEV, running in your clusters: CVE-2024-0001.");
        expect(ownerMail.text).toContain("https://app.test/radar-score");
        expect(ownerMail.text).toContain("https://app.test/feed");
        expect(ownerMail.text).toMatch(/https:\/\/api\.test\/v1\/digest\/unsubscribe\?token=/);
        expect(ownerMail.tags).toContainEqual({ name: "type", value: "weekly_digest" });

        const rows = await db.select().from(schema.digestSends).where(eq(schema.digestSends.orgId, org.id));
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.status === "sent" && r.week === "2026-W38" && r.resendMessageId)).toBe(true);
    });

    it("assembles the Radar Score, its week-old comparison and the top findings", async () => {
        const { digestService } = await import("../../../src/cloud/alerting/digest.service.js");
        const { orgRiskRollup } = await import("../../../src/db/risk.js");
        const { org } = await seedScannedOrg();
        const rollup = await orgRiskRollup(org.id);

        const content = await digestService.assemble(org.id);
        expect(content.radarScore).toBe(rollup.score);
        expect(content.radarScore).toBeGreaterThan(0);
        expect(content.radarScoreWeekAgo).toBeNull();
        expect(content.findingCount).toBe(1);
        expect(content.topFindings).toHaveLength(1);
        expect(content.topFindings[0]).toMatchObject({
            vulnId: "CVE-2024-0001",
            packageName: "lodash",
            fixedVersion: "4.17.22",
            kev: true,
            clusterName: "prod",
            workloadCount: 1,
        });
        expect(content.coverageProblems).toEqual([]);
    });

    it("records a rejected send as failed and carries on", async () => {
        const { digestService } = await import("../../../src/cloud/alerting/digest.service.js");
        const { org } = await seedScannedOrg();
        fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));

        const stats = await digestService.sendWeeklyDigests();
        expect(stats).toMatchObject({ orgs: 1, sent: 0, failed: 2 });
        const rows = await getTestDb().select().from(schema.digestSends).where(eq(schema.digestSends.orgId, org.id));
        expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    });

    it("updates the send log from the Resend webhook by message id", async () => {
        const { digestService } = await import("../../../src/cloud/alerting/digest.service.js");
        const { org } = await seedScannedOrg();
        await digestService.sendWeeklyDigests();
        const [row] = await getTestDb().select().from(schema.digestSends).where(eq(schema.digestSends.orgId, org.id));

        const body = JSON.stringify({ type: "email.bounced", created_at: "2026-09-14T08:00:00Z", data: { email_id: row!.resendMessageId } });
        const id = "msg_evt";
        const ts = String(Math.floor(Date.now() / 1000));
        const res = await request(app)
            .post("/v1/webhooks/resend")
            .set("svix-id", id)
            .set("svix-timestamp", ts)
            .set("svix-signature", `v1,${signResendPayload(WEBHOOK_SECRET, id, ts, body)}`)
            .set("Content-Type", "application/json")
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.handled).toBe(true);

        const [after] = await getTestDb().select().from(schema.digestSends).where(eq(schema.digestSends.id, row!.id));
        expect(after!.status).toBe("bounced");
    });

    describe("GET /v1/digest/unsubscribe", () => {
        it("switches the org's digest off with a valid token, without a session", async () => {
            const { signUnsubscribeToken } = await import("../../../src/cloud/alerting/unsubscribe-token.js");
            const { org } = await seedScannedOrg();

            const res = await request(app).get("/v1/digest/unsubscribe").query({ token: signUnsubscribeToken("digest", org.id) });
            expect(res.status).toBe(200);
            expect(res.text).toContain("Weekly digest switched off");

            const [after] = await getTestDb().select().from(schema.organizations).where(eq(schema.organizations.id, org.id));
            expect(after!.weeklyDigestEnabled).toBe(false);
        });

        it("refuses a tampered or missing token", async () => {
            const { signUnsubscribeToken } = await import("../../../src/cloud/alerting/unsubscribe-token.js");
            const { org } = await seedScannedOrg();
            const token = signUnsubscribeToken("digest", org.id);

            const tampered = await request(app).get("/v1/digest/unsubscribe").query({ token: token.slice(0, -2) + "zz" });
            expect(tampered.status).toBe(400);
            const missing = await request(app).get("/v1/digest/unsubscribe");
            expect(missing.status).toBe(400);
            const wrongKey = await request(app).get("/v1/digest/unsubscribe").query({ token: signUnsubscribeToken("digest", org.id, "other-secret") });
            expect(wrongKey.status).toBe(400);

            const [after] = await getTestDb().select().from(schema.organizations).where(eq(schema.organizations.id, org.id));
            expect(after!.weeklyDigestEnabled).toBe(true);
        });
    });
});
