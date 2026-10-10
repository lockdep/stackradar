/**
 * Exposure on the containers surfaces — docs/exposure-duration-plan-2026-09-19.md
 * item 5. The list carries the open interval alone ("on this image for");
 * the container page gets the stitched walk, per advisory, and one headline.
 */

import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createOrgWithOwner,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

describe("container exposure", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
        await getTestDb().update(schema.clusters).set({ firstInventoryAt: daysAgo(200) }).where(eq(schema.clusters.id, testData.cluster.id));
    });

    const headers = (orgId = testData.org.id, user = testData.user) =>
        createInternalHeaders({ id: user.id, email: user.email, orgId });

    async function advisory(vulnId: string, severityLevel: string, dates: { publishedAt?: Date; kevListedAt?: Date } = {}) {
        const [vuln] = await getTestDb()
            .insert(schema.vulnerabilities)
            .values(withFindingIdentity([{ vulnId, source: "osv", severityLevel, cvssScore: severityLevel === "critical" ? 9.8 : 5, ...dates }]))
            .returning();
        return vuln!;
    }

    async function scanned(imageId: string, findings: { pkg: string; vulnerabilityId: string }[]) {
        const db = getTestDb();
        const sbom = await createSbom(db, { imageId });
        for (const f of findings) {
            const [c] = await db
                .insert(schema.components)
                .values({ sbomId: sbom.id, name: f.pkg, version: "1.0.0", purl: `pkg:npm/${f.pkg}@1.0.0`, type: "library", isDirect: true })
                .returning();
            await db.insert(schema.componentVulnerabilities).values({ componentId: c!.id, vulnerabilityId: f.vulnerabilityId, matchedBy: "purl", matchType: "direct", matchConfidence: "exact" });
        }
        await db.insert(schema.vulnerabilityScanRuns).values({ orgId: testData.org.id, imageId, sbomId: sbom.id, trigger: "sbom_upload", status: "success" });
    }

    async function ran(image: { id: string; digest: string }, startedAt: Date, endedAt: Date | null) {
        await getTestDb().insert(schema.workloadContainerHistory).values({
            orgId: testData.org.id,
            clusterId: testData.cluster.id,
            namespace: "shop",
            workloadKind: "Deployment",
            workloadName: "api",
            containerName: "app",
            imageId: image.id,
            digest: image.digest,
            imageRef: `acme/app@${image.digest}`,
            startedAt,
            endedAt,
        });
    }

    it("stitches per advisory across digests, and names the longest exploited finding as the headline", async () => {
        const db = getTestDb();
        const { org, cluster } = testData;
        const old = await createImage(db, org.id, cluster.id);
        const now = await seedRunningImage(db, org.id, cluster.id, { workloadName: "api", namespace: "shop" });

        const kevListed = daysAgo(5);
        const carried = await advisory("CVE-2026-2001", "medium", { publishedAt: daysAgo(400), kevListedAt: kevListed });
        const fresh = await advisory("CVE-2026-2002", "critical", { publishedAt: daysAgo(400) });
        await scanned(old.id, [{ pkg: "lodash", vulnerabilityId: carried.id }]);
        await scanned(now.image.id, [{ pkg: "lodash", vulnerabilityId: carried.id }, { pkg: "react", vulnerabilityId: fresh.id }]);

        const started = daysAgo(25);
        const moved = daysAgo(3);
        await ran(old, started, moved);
        await ran(now.image, moved, null);

        const res = await request(app).get(`/api/containers/${now.container.id}/exposure`).set(headers());
        expect(res.status).toBe(200);

        // On both digests: the clock did not reset at the rollout.
        expect(new Date(res.body.findings["CVE-2026-2001"].presentSince).getTime()).toBe(started.getTime());
        expect(new Date(res.body.findings["CVE-2026-2001"].exploitedSince).getTime()).toBe(kevListed.getTime());
        // Only on the new digest, and the old one was scanned and clean of it: exact.
        expect(new Date(res.body.findings["CVE-2026-2002"].presentSince).getTime()).toBe(moved.getTime());
        expect(res.body.findings["CVE-2026-2002"].presentSinceIsLowerBound).toBe(false);

        // Exploited outranks a longer-running critical that is not.
        expect(res.body.longest).toMatchObject({ kind: "exploited", vulnId: "CVE-2026-2001", isLowerBound: false });
    });

    it("has no headline, rather than a zero, when nothing critical, high or exploited is on the container", async () => {
        const db = getTestDb();
        const now = await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "api", namespace: "shop" });
        const low = await advisory("CVE-2026-2003", "low", { publishedAt: daysAgo(400) });
        await scanned(now.image.id, [{ pkg: "lodash", vulnerabilityId: low.id }]);
        await ran(now.image, daysAgo(4), null);

        const res = await request(app).get(`/api/containers/${now.container.id}/exposure`).set(headers());
        expect(res.status).toBe(200);
        expect(res.body.findings["CVE-2026-2003"].presentSince).not.toBeNull();
        expect(res.body.longest).toBeNull();
    });

    it("is 404 for another org's container", async () => {
        const db = getTestDb();
        const now = await seedRunningImage(db, testData.org.id, testData.cluster.id);
        const stranger = await createOrgWithOwner(db);
        const res = await request(app).get(`/api/containers/${now.container.id}/exposure`).set(headers(stranger.org.id, stranger.user));
        expect(res.status).toBe(404);
    });

    it("lists each container with the start of its open interval on the running digest", async () => {
        const db = getTestDb();
        const { org, cluster } = testData;
        const now = await seedRunningImage(db, org.id, cluster.id, { workloadName: "api", namespace: "shop" });
        const bare = await seedRunningImage(db, org.id, cluster.id, { workloadName: "worker", namespace: "shop" });
        const old = await createImage(db, org.id, cluster.id);
        const moved = daysAgo(3);
        await ran(old, daysAgo(25), moved);
        await ran(now.image, moved, null);

        const res = await request(app).get("/api/containers").set(headers());
        expect(res.status).toBe(200);
        const byId = new Map<string, { onImageSince: string | null; onImageSinceIsLowerBound: boolean }>(
            res.body.map((c: { id: string }) => [c.id, c])
        );
        // This digest only: the earlier one is the container page's business.
        expect(new Date(byId.get(now.container.id)!.onImageSince!).getTime()).toBe(moved.getTime());
        expect(byId.get(now.container.id)!.onImageSinceIsLowerBound).toBe(false);
        // No interval recorded yet: null, never zero.
        expect(byId.get(bare.container.id)!.onImageSince).toBeNull();
        expect(byId.get(bare.container.id)!.onImageSinceIsLowerBound).toBe(false);

        // The image's own list of where it runs carries the same figure.
        const deployments = await request(app).get(`/api/images/${now.image.id}/deployments`).set(headers());
        expect(deployments.status).toBe(200);
        expect(new Date(deployments.body[0].onImageSince).getTime()).toBe(moved.getTime());
        expect(deployments.body[0].onImageSinceIsLowerBound).toBe(false);
        const bareDeployments = await request(app).get(`/api/images/${bare.image.id}/deployments`).set(headers());
        expect(bareDeployments.body[0].onImageSince).toBeNull();

        // Already running in the cluster's first report: a lower bound.
        await db.update(schema.clusters).set({ firstInventoryAt: moved }).where(eq(schema.clusters.id, cluster.id));
        const again = await request(app).get("/api/containers").set(headers());
        expect(again.body.find((c: { id: string }) => c.id === now.container.id).onImageSinceIsLowerBound).toBe(true);
    });
});
