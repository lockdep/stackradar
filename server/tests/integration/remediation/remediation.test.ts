/**
 * The remediation workflow, end to end against the HTTP surface:
 *
 * - the phase-1 rollup and its fixable / awaiting-fix / EOL split — the two
 *   null-fix buckets must never collapse into "no fix available";
 * - suppression with owner, reason and expiry, all mandatory, none automatic;
 * - the phase-2 delivery commands, including the refusals;
 * - the issue lifecycle (issues-workflow.md), whose `verified` state only the
 *   sweeps may write and whose manual exit `closed` requires a reason;
 * - finding-scoped issues, the post-scan verify sweep and the
 *   `issue.fix-available` consumer;
 * - the activity feed, which carries changes rather than inventory.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    createHelmRelease,
    createGitopsApplication,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let app: Awaited<ReturnType<typeof getTestApp>>;
let scenario: SeedTestScenarioResult;

function authHeaders() {
    return createInternalHeaders({
        id: scenario.user.id,
        email: scenario.user.email,
        orgId: scenario.org.id,
    });
}

async function advisory(vulnId: string, opts: { cvss?: number; severity?: string } = {}) {
    const db = getTestDb();
    const cvss = opts.cvss ?? 7.5;
    const [row] = await db
        .insert(schema.vulnerabilities)
        .values(withFindingIdentity([{
            vulnId,
            source: "osv",
            cvssScore: cvss,
            severityLevel: opts.severity ?? (cvss >= 9 ? "critical" : cvss >= 7 ? "high" : "medium"),
            aliases: [],
        }]))
        .returning();
    return row!;
}

/** A matched finding with the provenance columns the Fix split reads. */
async function finding(
    sbomId: string,
    packageName: string,
    vulnerabilityId: string,
    opts: { fixedVersion?: string | null; matchedEcosystem?: string | null } = {}
) {
    const db = getTestDb();
    const [component] = await db
        .insert(schema.components)
        .values({
            sbomId,
            name: packageName,
            version: "1.0.0",
            purl: `pkg:apk/alpine/${packageName}@1.0.0`,
            type: "library",
            isDirect: true,
        })
        .returning();
    await db.insert(schema.componentVulnerabilities).values({
        componentId: component!.id,
        vulnerabilityId,
        matchedBy: "purl",
        matchType: "direct",
        matchConfidence: "exact",
        fixedVersion: opts.fixedVersion ?? null,
        matchedEcosystem: opts.matchedEcosystem ?? null,
    });
}

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

describe("GET /api/remediation/rollup", () => {
    it("splits null-fix findings into awaiting-fix and EOL, and never collapses them", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        // Two workloads on one digest: one action, not two rows.
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "web", namespace: "default", imageTag: "1.25.2",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "proxy", namespace: "edge", imageTag: "1.25.2",
        });
        const sbom = await createSbom(db, { imageId: image.id });

        await finding(sbom.id, "libcrypto3", (await advisory("CVE-2024-0001")).id, {
            fixedVersion: "3.6.0-r0", matchedEcosystem: "Alpine:v3.16",
        });
        await finding(sbom.id, "zlib", (await advisory("CVE-2024-0002")).id, {
            fixedVersion: null, matchedEcosystem: "Alpine:v3.16", // EOL line
        });
        await finding(sbom.id, "left-pad", (await advisory("CVE-2024-0003")).id, {
            fixedVersion: null, matchedEcosystem: "npm", // no release line — awaiting
        });
        await finding(sbom.id, "busybox", (await advisory("CVE-2024-0004")).id, {
            fixedVersion: null, matchedEcosystem: null, // unknown — must not be claimed EOL
        });

        const res = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(1);

        const row = res.body.rows[0];
        expect(row.image.id).toBe(image.id);
        expect(row.workloadCount).toBe(2);
        expect(row.findings).toMatchObject({
            total: 4,
            fixable: 1,
            awaitingFix: 2,
            eol: 1,
            suppressed: 0,
        });
        expect(row.eolLines).toEqual([
            { releaseLine: "Alpine 3.16", eolDate: "2024-05-23", findings: 1 },
        ]);
        expect(res.body.totals.findings.eol).toBe(1);
    });

    it("does not list images with nothing to act on", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {});
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, { image });
        await createSbom(db, { imageId: image.id });

        const res = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(res.status).toBe(200);
        expect(res.body.rows).toHaveLength(0);
    });
});

describe("suppression", () => {
    async function seedOneFinding() {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {});
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, { image });
        const sbom = await createSbom(db, { imageId: image.id });
        await finding(sbom.id, "openssl", (await advisory("CVE-2024-1111")).id, {
            fixedVersion: "1.1.1t",
        });
        return image;
    }

    it("requires reason and a future expiry", async () => {
        await seedOneFinding();

        const missingReason = await request(app)
            .post("/api/remediation/suppressions")
            .set(authHeaders())
            .send({
                vulnId: "CVE-2024-1111", packageType: "library", packageName: "openssl",
                expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            });
        expect(missingReason.status).toBe(400);

        const pastExpiry = await request(app)
            .post("/api/remediation/suppressions")
            .set(authHeaders())
            .send({
                vulnId: "CVE-2024-1111", packageType: "library", packageName: "openssl",
                reason: "accepted for Q3", expiresAt: new Date(Date.now() - 1000).toISOString(),
            });
        expect(pastExpiry.status).toBe(400);
    });

    it("moves the finding into the suppressed bucket until expiry, and back on delete", async () => {
        await seedOneFinding();

        const created = await request(app)
            .post("/api/remediation/suppressions")
            .set(authHeaders())
            .send({
                vulnId: "CVE-2024-1111", packageType: "library", packageName: "openssl",
                reason: "compensating control in place",
                expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
            });
        expect(created.status).toBe(201);
        expect(created.body.createdByEmail).toBe(scenario.user.email);

        let rollup = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(rollup.body.rows[0].findings).toMatchObject({ total: 0, suppressed: 1 });

        const removed = await request(app)
            .delete(`/api/remediation/suppressions/${created.body.id}`)
            .set(authHeaders());
        expect(removed.status).toBe(200);

        rollup = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(rollup.body.rows[0].findings).toMatchObject({ total: 1, suppressed: 0 });
    });

    it("ignores an expired suppression", async () => {
        await seedOneFinding();
        const db = getTestDb();
        await db.insert(schema.findingStates).values({
            orgId: scenario.org.id,
            kind: "suppressed",
            packageType: "library",
            packageName: "openssl",
            vulnIdentity: "CVE-2024-1111",
            vulnId: "CVE-2024-1111",
            createdByUserId: scenario.user.id,
            createdByEmail: scenario.user.email,
            reason: "expired long ago",
            expiresAt: new Date(Date.now() - 86400_000),
        });

        const rollup = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(rollup.body.rows[0].findings).toMatchObject({ total: 1, suppressed: 0 });
    });
});

describe("GET /api/remediation/images/:id — the delivery path", () => {
    it("matches the command to how each workload is deployed, and refuses honestly", async () => {
        const db = getTestDb();
        await db
            .update(schema.clusters)
            .set({ ownerMetadataCollected: true })
            .where(eq(schema.clusters.id, scenario.cluster.id));

        const oldImage = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx", digest: "sha256:" + "a".repeat(64),
        });
        const newImage = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx", digest: "sha256:" + "b".repeat(64),
        });

        const release = await createHelmRelease(db, scenario.org.id, scenario.cluster.id, {
            name: "web", namespace: "infra", chartName: "nginx", chartVersion: "18.2.1",
        });
        const argoApp = await createGitopsApplication(db, scenario.org.id, scenario.cluster.id, {
            name: "edge", namespace: "argocd",
            repoUrl: "https://github.com/acme/deploy", targetRevision: "main", path: "apps/edge",
        });

        // Four ways of running one image.
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image: oldImage, workloadName: "chart-managed", namespace: "default",
            imageTag: "1.25.2", releaseId: release.id,
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image: oldImage, workloadName: "plain", namespace: "default", imageTag: "1.25.2",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image: oldImage, workloadName: "bare", namespace: "default",
            imageTag: "1.25.2", workloadKind: null,
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image: oldImage, workloadName: "delivered", namespace: "default",
            imageTag: "1.25.2", applicationId: argoApp.id,
        });
        // The measured candidate: a newer scanned tag of the same repository.
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image: newImage, workloadName: "canary", namespace: "default", imageTag: "1.25.6",
        });

        await createSbom(db, { imageId: oldImage.id });
        await createSbom(db, { imageId: newImage.id });

        const res = await request(app)
            .get(`/api/remediation/images/${oldImage.id}`)
            .set(authHeaders());
        expect(res.status).toBe(200);
        expect(res.body.upgrade.availability).toBe("available");
        expect(res.body.upgrade.best.tag).toBe("1.25.6");

        const byName = new Map(
            res.body.workloads.map((w: { workloadName: string }) => [w.workloadName, w])
        );

        const chartManaged = byName.get("chart-managed") as any;
        expect(chartManaged.delivery.method).toBe("helm");
        expect(chartManaged.delivery.command).toBe(
            "helm upgrade web -n infra --reuse-values --set image.tag=1.25.6"
        );

        const plain = byName.get("plain") as any;
        expect(plain.delivery.method).toBe("kubectl");
        expect(plain.delivery.command).toBe(
            "kubectl set image deployment/plain app=library/nginx:1.25.6 -n default"
        );

        const bare = byName.get("bare") as any;
        expect(bare.delivery.command).toBeNull();

        const delivered = byName.get("delivered") as any;
        expect(delivered.delivery.method).toBe("argocd");
        expect(delivered.delivery.command).toBeNull();
        expect(delivered.delivery.summary).toContain("apps/edge");
    });

    it("never claims a workload is unmanaged when owner metadata was not collected", async () => {
        const db = getTestDb();
        // ownerMetadataCollected stays null — "we could not look".
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "plain", imageTag: "1.25.2",
        });
        await createSbom(db, { imageId: image.id });

        const res = await request(app)
            .get(`/api/remediation/images/${image.id}`)
            .set(authHeaders());
        expect(res.status).toBe(200);
        const plain = res.body.workloads[0];
        expect(plain.delivery.method).toBe("unknown");
        expect(plain.delivery.command).toBeNull();
        expect(plain.delivery.summary).not.toMatch(/not chart-managed/i);
    });

    it("is 404 for another org's image", async () => {
        const db = getTestDb();
        const other = await seedTestScenario(db, { email: "other@example.com" });
        const image = await createImage(db, other.org.id, other.cluster.id, {});

        const res = await request(app)
            .get(`/api/remediation/images/${image.id}`)
            .set(authHeaders());
        expect(res.status).toBe(404);
    });
});

describe("the issue lifecycle and the verify loops", () => {
    it("runs open → snoozed → applied, and only the inventory sweep verifies", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "web", imageTag: "1.25.2",
        });

        const created = await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({ scope: "image", imageId: image.id, toTag: "1.25.6" });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            state: "open",
            fromDigest: image.digest,
            repository: "library/nginx",
            toTag: "1.25.6",
        });
        const issueId = created.body.id;

        // Snoozing requires a future date.
        const badSnooze = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "snoozed" });
        expect(badSnooze.status).toBe(400);

        const snoozed = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "snoozed", snoozedUntil: new Date(Date.now() + 86400_000).toISOString() });
        expect(snoozed.status).toBe(200);
        expect(snoozed.body.effectiveState).toBe("snoozed");

        const applied = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "applied" });
        expect(applied.status).toBe(200);
        expect(applied.body.appliedAt).toBeTruthy();

        // The request layer cannot ask for `verified` at all.
        const askVerified = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "verified" });
        expect(askVerified.status).toBe(400);

        const { verifyAppliedIssues } = await import(
            "../../../src/services/remediation.service.js"
        );

        // The vulnerable digest is still running: nothing verifies.
        expect(await verifyAppliedIssues(scenario.cluster.id)).toBe(0);

        // The next inventory report no longer carries the old digest.
        await db
            .delete(schema.workloadContainers)
            .where(eq(schema.workloadContainers.imageId, image.id));
        expect(await verifyAppliedIssues(scenario.cluster.id)).toBe(1);

        const after = await request(app).get("/api/remediation/issues").set(authHeaders());
        expect(after.body[0]).toMatchObject({ state: "verified" });
        expect(after.body[0].verifiedAt).toBeTruthy();

        // Verified is history.
        const reopen = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "open" });
        expect(reopen.status).toBe(409);

        // The feed carries the whole story, newest first.
        const activity = await request(app).get("/api/remediation/activity").set(authHeaders());
        expect(activity.status).toBe(200);
        expect(activity.body.map((e: { type: string }) => e.type)).toEqual([
            "issue.verified",
            "issue.applied",
            "issue.snoozed",
            "issue.created",
        ]);
    });

    it("verifies a release issue when the chart version moves, not when the release disappears", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, scenario.org.id, scenario.cluster.id, {
            name: "monitoring", namespace: "obs",
            chartName: "kube-prometheus-stack", chartVersion: "82.18.0",
        });

        const created = await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({ scope: "release", releaseId: release.id, toChartVersion: "83.1.0" });
        expect(created.status).toBe(201);

        await request(app)
            .patch(`/api/remediation/issues/${created.body.id}`)
            .set(authHeaders())
            .send({ state: "applied" });

        const { verifyAppliedIssues } = await import(
            "../../../src/services/remediation.service.js"
        );
        expect(await verifyAppliedIssues(scenario.cluster.id)).toBe(0);

        await db
            .update(schema.helmReleases)
            .set({ chartVersion: "83.1.0" })
            .where(eq(schema.helmReleases.id, release.id));
        expect(await verifyAppliedIssues(scenario.cluster.id)).toBe(1);
    });

    it("closes with a mandatory reason, attributes the closer, and closed is terminal", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "web", imageTag: "1.25.2",
        });

        const created = await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({ scope: "image", imageId: image.id });
        const issueId = created.body.id;

        // No reason, no close.
        const bareClose = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "closed" });
        expect(bareClose.status).toBe(400);

        const closed = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({
                state: "closed",
                closedReason: "fixed-otherwise",
                closedNote: "rebuilt the image on a patched base instead",
            });
        expect(closed.status).toBe(200);
        expect(closed.body).toMatchObject({
            state: "closed",
            closedReason: "fixed-otherwise",
            closedByEmail: scenario.user.email,
        });
        expect(closed.body.closedAt).toBeTruthy();
        // Closed is the user's statement, never the system's.
        expect(closed.body.verifiedAt).toBeNull();

        // Closed is history, like verified.
        const reopen = await request(app)
            .patch(`/api/remediation/issues/${issueId}`)
            .set(authHeaders())
            .send({ state: "open" });
        expect(reopen.status).toBe(409);

        const activity = await request(app).get("/api/remediation/activity").set(authHeaders());
        expect(activity.body[0]).toMatchObject({ type: "issue.closed" });
        expect(activity.body[0].payload.closedReason).toBe("fixed-otherwise");
    });

    it("a closed issue no longer counts against its image's open-issue link", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "web", imageTag: "1.25.2",
        });
        const sbom = await createSbom(db, { imageId: image.id });
        await finding(sbom.id, "libssl3", (await advisory("CVE-2024-2222")).id, {
            fixedVersion: "3.6.0-r0",
        });

        const created = await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({ scope: "image", imageId: image.id });

        let rollup = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(rollup.body.rows[0].openIssues).toBe(1);

        await request(app)
            .patch(`/api/remediation/issues/${created.body.id}`)
            .set(authHeaders())
            .send({ state: "closed", closedReason: "wont-fix" });

        rollup = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(rollup.body.rows[0].openIssues).toBe(0);
    });
});

describe("finding-scoped issues", () => {
    /** One counted finding, returned with its image, for identity tracking. */
    async function seedTrackedFinding(vulnId = "CVE-2024-7777") {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image, workloadName: "web", imageTag: "1.25.2",
        });
        const sbom = await createSbom(db, { imageId: image.id });
        await finding(sbom.id, "openssl", (await advisory(vulnId)).id, {
            fixedVersion: null, matchedEcosystem: "npm",
        });
        return image;
    }

    it("opens on the collapsed identity, org-wide, and refuses a duplicate", async () => {
        await seedTrackedFinding();

        const created = await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({
                scope: "finding",
                vulnId: "CVE-2024-7777",
                packageType: "library",
                packageName: "openssl",
            });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            scope: "finding",
            clusterId: null, // a finding identity is org-wide by construction
            vulnIdentity: "CVE-2024-7777",
            vulnId: "CVE-2024-7777",
        });

        const duplicate = await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({
                scope: "finding",
                vulnId: "CVE-2024-7777",
                packageType: "library",
                packageName: "openssl",
            });
        expect(duplicate.status).toBe(409);

        // The list computes the finding's live status — never stores it.
        const list = await request(app).get("/api/remediation/issues").set(authHeaders());
        expect(list.status).toBe(200);
        expect(list.body[0].finding).toMatchObject({ remaining: 1 });
        expect(list.body[0].finding.perCluster).toHaveLength(1);
    });

    it("verifies through the scan sweep only when no counted finding remains in the org", async () => {
        const db = getTestDb();
        const image = await seedTrackedFinding();

        // The same identity in a second cluster: org-wide means both count.
        const { createCluster } = await import("../../fixtures/seed-data.js");
        const otherCluster = await createCluster(db, scenario.org.id, { name: "prod-eu" });
        const otherImage = await createImage(db, scenario.org.id, otherCluster.id, {
            repository: "library/nginx", digest: "sha256:" + "c".repeat(64),
        });
        await seedRunningImage(db, scenario.org.id, otherCluster.id, {
            image: otherImage, workloadName: "web-eu", imageTag: "1.25.2",
        });
        const otherSbom = await createSbom(db, { imageId: otherImage.id });
        const [vuln] = await db
            .select()
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2024-7777"));
        await finding(otherSbom.id, "openssl", vuln!.id, {
            fixedVersion: null, matchedEcosystem: "npm",
        });

        await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({
                scope: "finding",
                vulnId: "CVE-2024-7777",
                packageType: "library",
                packageName: "openssl",
            });

        const { verifyFindingIssues } = await import(
            "../../../src/services/remediation.service.js"
        );

        // Still counted in both clusters: stays open.
        expect(await verifyFindingIssues(scenario.org.id)).toBe(0);

        // Gone from one cluster, persisting in the other: still open —
        // org-wide identity, and the per-cluster split says where.
        await db.delete(schema.sboms).where(eq(schema.sboms.imageId, image.id));
        expect(await verifyFindingIssues(scenario.org.id)).toBe(0);
        const list = await request(app).get("/api/remediation/issues").set(authHeaders());
        expect(list.body[0].finding).toMatchObject({ remaining: 1 });
        expect(list.body[0].finding.perCluster).toEqual([
            { clusterId: otherCluster.id, clusterName: "prod-eu", count: 1 },
        ]);

        // Gone everywhere: the sweep — and only the sweep — verifies.
        await db.delete(schema.sboms).where(eq(schema.sboms.imageId, otherImage.id));
        expect(await verifyFindingIssues(scenario.org.id)).toBe(1);

        const after = await request(app).get("/api/remediation/issues").set(authHeaders());
        expect(after.body[0]).toMatchObject({ state: "verified" });

        const activity = await request(app).get("/api/remediation/activity").set(authHeaders());
        expect(activity.body[0]).toMatchObject({ type: "issue.verified" });
    });

    it("emits issue.fix-available for tracked findings when an advisory gains a fix", async () => {
        const db = getTestDb();
        await seedTrackedFinding("CVE-2024-8888");

        await request(app)
            .post("/api/remediation/issues")
            .set(authHeaders())
            .send({
                scope: "finding",
                vulnId: "CVE-2024-8888",
                packageType: "library",
                packageName: "openssl",
            });

        const [vuln] = await db
            .select()
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2024-8888"));

        const { notifyFixAvailable } = await import(
            "../../../src/services/remediation.service.js"
        );
        expect(await notifyFixAvailable([vuln!.id])).toBe(1);

        const activity = await request(app).get("/api/remediation/activity").set(authHeaders());
        expect(activity.body[0]).toMatchObject({ type: "issue.fix-available" });
        expect(activity.body[0].payload).toMatchObject({
            vulnId: "CVE-2024-8888",
            packageName: "openssl",
        });

        // A terminal issue is nobody to tell: close it, then no event.
        const list = await request(app).get("/api/remediation/issues").set(authHeaders());
        await request(app)
            .patch(`/api/remediation/issues/${list.body[0].id}`)
            .set(authHeaders())
            .send({ state: "closed", closedReason: "no-longer-relevant" });
        expect(await notifyFixAvailable([vuln!.id])).toBe(0);
    });
});
