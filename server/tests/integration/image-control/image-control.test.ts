import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { resolveImageControl } from "../../../src/services/image-control.service.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createHelmRelease,
    createUser,
    addOrgMember,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * `images.control` (component tier plan, item 11): derived per repository,
 * corrected once per repository by the org, audited.
 *
 * Three running repositories:
 *
 *   registry.corp.example/team/api        private registry            → built
 *   quay.io/prometheus/prometheus         delivered by a public chart → third-party
 *   ghcr.io/acme/worker                   nothing decides             → unknown
 */
describe("image control", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;
    let ids: { api: string; prometheus: string; worker: string };

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
        const { org, cluster } = testData;

        const api = await createImage(db, org.id, cluster.id, {
            registry: "registry.corp.example",
            repository: "team/api",
        });
        const prometheus = await createImage(db, org.id, cluster.id, {
            registry: "quay.io",
            repository: "prometheus/prometheus",
        });
        const worker = await createImage(db, org.id, cluster.id, { registry: "ghcr.io", repository: "acme/worker" });
        ids = { api: api.id, prometheus: prometheus.id, worker: worker.id };

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "monitoring",
            namespace: "monitoring",
            chartName: "kube-prometheus-stack",
            chartVersion: "65.1.0",
        });
        await seedRunningImage(db, org.id, cluster.id, { image: api, workloadName: "api" });
        await seedRunningImage(db, org.id, cluster.id, { image: worker, workloadName: "worker" });
        await seedRunningImage(db, org.id, cluster.id, {
            image: prometheus,
            workloadName: "prometheus",
            namespace: "monitoring",
            releaseId: release.id,
        });

        // The chart is attributed to a public package, and its renders name the image.
        const repoUrl = "https://prometheus-community.github.io/helm-charts";
        const [pkg] = await db
            .insert(schema.artifactHubPackages)
            .values({
                name: "kube-prometheus-stack",
                repoName: "prometheus-community",
                repoUrl,
                versions: [],
                lastSeenAt: new Date(),
            })
            .returning();
        await db.insert(schema.chartAttributions).values({
            orgId: org.id,
            chartName: "kube-prometheus-stack",
            packageId: pkg!.id,
            repoUrl,
            evidence: {},
            matchedAt: new Date(),
        });
        await db.insert(schema.chartImageObservations).values({
            repoUrl,
            chartName: "kube-prometheus-stack",
            chartVersion: "65.1.0",
            imageRef: "quay.io/prometheus/prometheus:v2.54.1",
            registry: "quay.io",
            repository: "prometheus/prometheus",
            tag: "v2.54.1",
        });
    });

    function headers(user = testData.user): Record<string, string> {
        return createInternalHeaders({
            id: user.id,
            email: user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    async function controlOf(imageId: string) {
        const [row] = await getTestDb()
            .select({
                control: schema.images.control,
                by: schema.images.controlDetectedBy,
                detail: schema.images.controlDetail,
            })
            .from(schema.images)
            .where(eq(schema.images.id, imageId));
        return row!;
    }

    it("derives control per signal and reports the histogram", async () => {
        const stats = await resolveImageControl(testData.org.id);
        expect(stats.histogram).toMatchObject({ "private-registry": 1, chart: 1, unknown: 1 });

        expect(await controlOf(ids.api)).toEqual({
            control: "built",
            by: "private-registry",
            detail: "registry.corp.example",
        });
        expect(await controlOf(ids.prometheus)).toEqual({
            control: "third-party",
            by: "chart",
            detail: "kube-prometheus-stack",
        });
        expect(await controlOf(ids.worker)).toEqual({ control: "unknown", by: null, detail: null });

        // Idempotent: a second pass writes nothing.
        expect((await resolveImageControl(testData.org.id)).changed).toBe(0);
    });

    it("carries control on container rows", async () => {
        await resolveImageControl(testData.org.id);
        const res = await request(app).get("/api/containers").set(headers());
        expect(res.status).toBe(200);
        const rows = (res.body.containers ?? res.body) as {
            repository: string;
            control: string;
            controlDetectedBy: string | null;
        }[];
        const byRepo = Object.fromEntries(rows.map((r) => [r.repository, [r.control, r.controlDetectedBy]]));
        expect(byRepo).toMatchObject({
            "team/api": ["built", "private-registry"],
            "prometheus/prometheus": ["third-party", "chart"],
            "acme/worker": ["unknown", null],
        });
    });

    it("lists repositories with what was detected, to admins only", async () => {
        await resolveImageControl(testData.org.id);
        const url = `/api/organizations/${testData.org.id}/image-control`;

        const res = await request(app).get(url).set(headers());
        expect(res.status).toBe(200);
        expect(res.body.unknownCount).toBe(1);
        expect(res.body.repositories.map((r: { repository: string }) => r.repository).sort()).toEqual([
            "acme/worker",
            "prometheus/prometheus",
            "team/api",
        ]);
        const prometheus = res.body.repositories.find(
            (r: { repository: string }) => r.repository === "prometheus/prometheus",
        );
        expect(prometheus).toMatchObject({
            registry: "quay.io",
            control: "third-party",
            detected: { control: "third-party", detectedBy: "chart", detail: "kube-prometheus-stack" },
            rule: null,
            imageCount: 1,
            containerCount: 1,
        });

        const member = await createUser(getTestDb(), { email: "member@example.com" });
        await addOrgMember(getTestDb(), member.id, testData.org.id, "member");
        expect((await request(app).get(url).set(headers(member))).status).toBe(403);
    });

    it("applies the org's answers, audits them, and resets on null", async () => {
        await resolveImageControl(testData.org.id);
        const url = `/api/organizations/${testData.org.id}/image-control-rules`;

        const set = await request(app)
            .put(url)
            .set(headers())
            .send({ rules: [{ registry: "ghcr.io", repository: "acme/worker", control: "built" }] });
        expect(set.status).toBe(200);
        expect(set.body).toMatchObject({ changed: 1, unknownCount: 0 });
        expect(await controlOf(ids.worker)).toEqual({ control: "built", by: "rule", detail: null });

        // The same answer again is not a change, and writes no second event.
        const again = await request(app)
            .put(url)
            .set(headers())
            .send({ rules: [{ registry: "ghcr.io", repository: "acme/worker", control: "built" }] });
        expect(again.body.changed).toBe(0);

        // A rule beats a derived verdict, and the list still says what was detected.
        const override = await request(app)
            .put(url)
            .set(headers())
            .send({
                rules: [{ registry: "quay.io", repository: "prometheus/*", control: "built", reason: "we rebuild it" }],
            });
        const prometheus = override.body.repositories.find(
            (r: { repository: string }) => r.repository === "prometheus/prometheus",
        );
        expect(prometheus).toMatchObject({
            control: "built",
            detected: { control: "third-party", detectedBy: "chart" },
            rule: { control: "built", reason: "we rebuild it" },
        });

        const reset = await request(app)
            .put(url)
            .set(headers())
            .send({ rules: [{ registry: "ghcr.io", repository: "acme/worker", control: null }] });
        expect(reset.body).toMatchObject({ changed: 1, unknownCount: 1 });
        expect(await controlOf(ids.worker)).toMatchObject({ control: "unknown", by: null });

        const events = await getTestDb()
            .select({ payload: schema.activityEvents.payload })
            .from(schema.activityEvents)
            .where(eq(schema.activityEvents.type, "image.control-set"));
        expect(events).toHaveLength(3);
        expect(events.map((e) => e.payload["control"]).sort()).toEqual(["built", "built", null].sort());
    });

    it("refuses members, and refuses a wildcard anywhere but the end", async () => {
        const url = `/api/organizations/${testData.org.id}/image-control-rules`;
        const member = await createUser(getTestDb(), { email: "member2@example.com" });
        await addOrgMember(getTestDb(), member.id, testData.org.id, "member");

        const forbidden = await request(app)
            .put(url)
            .set(headers(member))
            .send({ rules: [{ repository: "acme/worker", control: "built" }] });
        expect(forbidden.status).toBe(403);

        const bad = await request(app)
            .put(url)
            .set(headers())
            .send({ rules: [{ repository: "ac*me/worker", control: "built" }] });
        expect(bad.status).toBe(400);
    });
});
