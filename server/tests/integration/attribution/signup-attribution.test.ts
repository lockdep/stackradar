import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { createUser, createOrganization, addOrgMember, createCluster } from "../../fixtures/seed-data.js";
import { signupAttributions, users } from "../../../src/db/schema/index.js";
import type { User } from "../../../src/db/schema/index.js";
import { config } from "../../../src/config/index.js";
import { attributionService, type ClusterReport } from "../../../src/cloud/attribution/attribution.service.js";

/**
 * Sign-up attribution: the row `POST /users/setup` writes, the two PostHog
 * funnel events every row drives, and the two ad-network conversions a
 * click-id row drives. The network is a stubbed `fetch`; each sender's own
 * request shape is covered by its unit test.
 */
import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Sign-up attribution", () => {
    let app: Express;
    let user: User;
    const fetchMock = vi.fn();
    const reddit = config.reddit as { pixelId: string; conversionsToken: string };
    const posthog = config.posthog as { apiKey: string };
    const founder = config.founderAlerts as { email: string; slackWebhookUrl: string };
    const email = config.email as { resendApiKey: string };
    /** A report from a cluster of this org, as the inventory controller passes it. */
    const report = (clusterId: string): ClusterReport => ({
        clusterId,
        accepted: { namespaces: 2, workloads: 5, containers: 6 },
        scannerVersion: "0.4.1",
    });

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        user = await createUser(getTestDb(), { email: "user@test.com" });
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        reddit.pixelId = "";
        reddit.conversionsToken = "";
        posthog.apiKey = "";
        founder.email = "";
        founder.slackWebhookUrl = "";
        email.resendApiKey = "";
    });
    afterEach(() => vi.unstubAllGlobals());

    function setup(body: Record<string, unknown> = {}) {
        return request(app)
            .post("/api/users/setup")
            .set(createInternalHeaders({ id: user.id, email: user.email }))
            .send({ userId: user.id, userEmail: user.email, ...body });
    }

    async function rows() {
        return getTestDb().select().from(signupAttributions).where(eq(signupAttributions.userId, user.id));
    }

    it("writes an empty row for an organic sign-up, without calling any network when unconfigured", async () => {
        const res = await setup();
        expect(res.status).toBe(201);
        const [row] = await rows();
        expect(row).toMatchObject({
            orgId: res.body.organization.id,
            clickId: null,
            utmSource: null,
            analyticsSignupSentAt: null,
            signupEventSentAt: null,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends signup_completed to PostHog for an organic sign-up and stamps it", async () => {
        posthog.apiKey = "phc_test";

        const res = await setup({ attribution: { utmSource: "hn" } });
        expect(res.status).toBe(201);
        await vi.waitFor(async () => {
            expect((await rows())[0]?.analyticsSignupSentAt).not.toBeNull();
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://eu.i.posthog.com/i/v0/e");
        expect(JSON.parse(init.body)).toMatchObject({
            api_key: "phc_test",
            event: "signup_completed",
            distinct_id: res.body.organization.id,
            properties: { org_id: res.body.organization.id, utm_source: "hn", ad_network: null },
        });
        // No ad conversion without a click id.
        expect((await rows())[0]?.signupEventSentAt).toBeNull();
    });

    it("sends first_sbom_received once per org, on the first report, for an organic sign-up", async () => {
        posthog.apiKey = "phc_test";
        const org = await createOrganization(getTestDb());
        await addOrgMember(getTestDb(), user.id, org.id, "owner");
        await getTestDb().insert(signupAttributions).values({ userId: user.id, orgId: org.id });

        const cluster = await createCluster(getTestDb(), org.id);
        await attributionService.onClusterReported(org.id, report(cluster.id));
        await attributionService.onClusterReported(org.id, report(cluster.id));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body).toMatchObject({ event: "first_sbom_received", distinct_id: org.id });
        expect(body.properties.hours_since_signup).toBeGreaterThanOrEqual(0);
        expect((await rows())[0]?.analyticsClusterSentAt).not.toBeNull();
        expect((await rows())[0]?.clusterEventSentAt).toBeNull();
    });

    it("sends both receivers their cluster event for a click-id sign-up, each once", async () => {
        posthog.apiKey = "phc_test";
        reddit.pixelId = "a2_test";
        reddit.conversionsToken = "tok";
        const org = await createOrganization(getTestDb());
        await addOrgMember(getTestDb(), user.id, org.id, "owner");
        await getTestDb().insert(signupAttributions).values({ userId: user.id, orgId: org.id, clickId: "rdt_abc" });

        const cluster = await createCluster(getTestDb(), org.id);
        await attributionService.onClusterReported(org.id, report(cluster.id));
        await attributionService.onClusterReported(org.id, report(cluster.id));

        const urls = fetchMock.mock.calls.map((c) => c[0]);
        expect(urls).toHaveLength(2);
        expect(urls).toContain("https://eu.i.posthog.com/i/v0/e");
        expect(urls.some((u) => String(u).includes("/conversion_events"))).toBe(true);
        const [row] = await rows();
        expect(row?.analyticsClusterSentAt).not.toBeNull();
        expect(row?.clusterEventSentAt).not.toBeNull();
    });

    it("records the click id and utm tags against the new org, without calling the network when unconfigured", async () => {
        const res = await setup({
            attribution: { clickId: "rdt_abc", utmSource: "reddit", utmCampaign: "k8s-a4" },
        });
        expect(res.status).toBe(201);

        const [row] = await rows();
        expect(row).toMatchObject({
            orgId: res.body.organization.id,
            clickId: "rdt_abc",
            utmSource: "reddit",
            utmCampaign: "k8s-a4",
            utmMedium: null,
            signupEventSentAt: null,
            clusterEventSentAt: null,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the first attribution when setup is re-posted and ignores a malformed one", async () => {
        expect((await setup({ attribution: { clickId: "first" } })).status).toBe(201);
        expect((await setup({ attribution: { clickId: "second" } })).status).toBe(200);
        expect((await setup({ attribution: "garbage" })).status).toBe(200);
        expect((await rows()).map((r) => r.clickId)).toEqual(["first"]);
    });

    it("reports the sign-up conversion and stamps it once the network accepts", async () => {
        reddit.pixelId = "a2_test";
        reddit.conversionsToken = "tok";

        expect((await setup({ attribution: { clickId: "rdt_abc" } })).status).toBe(201);
        // The send is deliberately not awaited by setup; give it a tick.
        await vi.waitFor(async () => {
            expect((await rows())[0]?.signupEventSentAt).not.toBeNull();
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.data.events[0]).toMatchObject({
            type: { tracking_type: "SIGN_UP" },
            click_id: "rdt_abc",
            metadata: { conversion_id: `signup:${user.id}` },
        });
    });

    it("reports the cluster-connected conversion once per attributed org", async () => {
        reddit.pixelId = "a2_test";
        reddit.conversionsToken = "tok";
        const org = await createOrganization(getTestDb());
        await addOrgMember(getTestDb(), user.id, org.id, "owner");
        await getTestDb().insert(signupAttributions).values({ userId: user.id, orgId: org.id, clickId: "rdt_abc" });

        const cluster = await createCluster(getTestDb(), org.id);
        await attributionService.onClusterReported(org.id, report(cluster.id));
        await attributionService.onClusterReported(org.id, report(cluster.id));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.data.events[0]).toMatchObject({
            type: { tracking_type: "LEAD" },
            click_id: "rdt_abc",
            metadata: { conversion_id: `cluster:${user.id}` },
        });
        expect((await rows())[0]?.clusterEventSentAt).not.toBeNull();
    });

    it("does not stamp a conversion the network rejected, so it is retried next time", async () => {
        reddit.pixelId = "a2_test";
        reddit.conversionsToken = "tok";
        fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
        const org = await createOrganization(getTestDb());
        await addOrgMember(getTestDb(), user.id, org.id, "owner");
        await getTestDb().insert(signupAttributions).values({ userId: user.id, orgId: org.id, clickId: "rdt_abc" });

        const cluster = await createCluster(getTestDb(), org.id);
        await attributionService.onClusterReported(org.id, report(cluster.id));
        expect((await rows())[0]?.clusterEventSentAt).toBeNull();

        fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
        await attributionService.onClusterReported(org.id, report(cluster.id));
        expect((await rows())[0]?.clusterEventSentAt).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("stores the browser's time zone and language beside the campaign tags", async () => {
        const res = await setup({ attribution: { utmSource: "hn", timezone: "Europe/Oslo", locale: "nb-NO" } });
        expect(res.status).toBe(201);
        expect((await rows())[0]).toMatchObject({ utmSource: "hn", timezone: "Europe/Oslo", locale: "nb-NO" });
    });

    it("drops a malformed time zone or language without failing setup or losing the rest", async () => {
        const res = await setup({ attribution: { utmSource: "hn", timezone: "<script>", locale: "nb-NO" } });
        expect(res.status).toBe(201);
        // The whole attribution object fails validation and is recorded as "no attribution".
        expect((await rows())[0]).toMatchObject({ utmSource: null, timezone: null, locale: null });
    });

    it("emails the founder on sign-up, Reply-To the person, and stamps it once", async () => {
        founder.email = "founder@test";
        email.resendApiKey = "re_test";
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));

        const res = await setup({ attribution: { utmSource: "hn", timezone: "Europe/Oslo" } });
        expect(res.status).toBe(201);
        await vi.waitFor(async () => {
            expect((await rows())[0]?.founderSignupAlertSentAt).not.toBeNull();
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://api.resend.com/emails");
        const body = JSON.parse(init.body);
        expect(body.to).toEqual(["founder@test"]);
        expect(body.reply_to).toBe("user@test.com");
        expect(body.subject).toContain("New sign-up: user@test.com (Europe/Oslo)");
        expect(body.text).toContain(`Organisation: ${res.body.organization.name}`);

        // Re-posting setup neither re-creates the row nor re-alerts.
        expect((await setup()).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("emails the founder once when the org's first cluster reports, naming the cluster", async () => {
        founder.email = "founder@test";
        email.resendApiKey = "re_test";
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
        const org = await createOrganization(getTestDb(), { name: "Acme" });
        await addOrgMember(getTestDb(), user.id, org.id, "owner");
        await getTestDb().insert(signupAttributions).values({ userId: user.id, orgId: org.id, locale: "en-US" });
        const cluster = await createCluster(getTestDb(), org.id, { name: "prod-eu" });

        await attributionService.onClusterReported(org.id, report(cluster.id));
        await attributionService.onClusterReported(org.id, report(cluster.id));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
        expect(body.to).toEqual(["founder@test"]);
        expect(body.reply_to).toBe("user@test.com");
        expect(body.subject).toBe("Cluster connected: Acme · prod-eu");
        expect(body.text).toContain("Reported: 6 containers in 5 workloads across 2 namespaces");
        expect(body.text).toContain("Scanner: 0.4.1");
        expect(body.text).toContain("Language: en-US");
        expect((await rows())[0]?.founderClusterAlertSentAt).not.toBeNull();
    });

    it("keeps owing the founder alert while unconfigured, and sends it once configured", async () => {
        const org = await createOrganization(getTestDb());
        await addOrgMember(getTestDb(), user.id, org.id, "owner");
        await getTestDb().insert(signupAttributions).values({ userId: user.id, orgId: org.id });
        const cluster = await createCluster(getTestDb(), org.id);

        await attributionService.onClusterReported(org.id, report(cluster.id));
        expect(fetchMock).not.toHaveBeenCalled();
        expect((await rows())[0]?.founderClusterAlertSentAt).toBeNull();

        founder.slackWebhookUrl = "https://hooks.slack.test/abc";
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
        await attributionService.onClusterReported(org.id, report(cluster.id));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]![0]).toBe("https://hooks.slack.test/abc");
        expect((await rows())[0]?.founderClusterAlertSentAt).not.toBeNull();
    });

    it("is deleted with the user", async () => {
        expect((await setup({ attribution: { clickId: "rdt_abc" } })).status).toBe(201);
        expect(await rows()).toHaveLength(1);
        await getTestDb().delete(users).where(eq(users.id, user.id));
        expect(await rows()).toHaveLength(0);
    });
});
