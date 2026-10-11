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
    createCluster,
    createOrgWithOwner,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import { classifySearchTerm } from "../../../src/repositories/search.repository.js";

/**
 * GET /api/search — the global palette's one request.
 *
 * Five groups, each scoped to the caller's org, ordered by what the term
 * looks like; a direct hit when the term is an advisory id the org's fleet
 * carries.
 */
describe("classifySearchTerm", () => {
    it.each([
        "CVE-2021-44228",
        "cve-2021-44228",
        "GHSA-jfh8-c2jp-5v3q",
        "USN-6412-1",
        "RUSTSEC-2021-0139",
        "PYSEC-2021-1",
        "GO-2022-0001",
        "DSA-5231-1",
        "RHSA-2024:3351",
        "UBUNTU-CVE-2022-3296",
        "SUSE-SU-2026:23213-1",
        "DRUPAL-CORE-2018-002",
        "BIT-memcached-2023-27478",
        "AZL-86814",
        "DLA-74-1",
    ])("reads %s as an advisory id", (term) => {
        expect(classifySearchTerm(term)).toBe("advisory");
    });

    it.each(["nginx:1.25", "ghcr.io/acme/app", "acme/app@sha256:abc", "app@sha256"])(
        "reads %s as an image ref",
        (term) => {
            expect(classifySearchTerm(term)).toBe("image");
        },
    );

    it.each(["coredns", "kube-state-metrics", "cert-manager-webhook", "log4j", "prod", "nginx-ingress-controller"])(
        "reads %s as a name",
        (term) => {
            expect(classifySearchTerm(term)).toBe("name");
        },
    );
});

describe("GET /api/search", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb(), {}, { name: "Acme", slug: "acme" });
    });

    function authHeaders(scenario: SeedTestScenarioResult = testData): Record<string, string> {
        return createInternalHeaders({
            id: scenario.user.id,
            email: scenario.user.email,
            orgId: scenario.org.id,
            orgName: scenario.org.name,
            orgSlug: scenario.org.slug,
        });
    }

    async function component(sbomId: string, name: string, version: string, ecosystem = "npm") {
        const [c] = await getTestDb()
            .insert(schema.components)
            .values({
                sbomId,
                name,
                version,
                purl: `pkg:${ecosystem}/${name}@${version}`,
                type: "library",
                isDirect: true,
            })
            .returning();
        return c!;
    }

    async function advisory(vulnId: string, severityLevel: string | null = "high") {
        const [vuln] = await getTestDb()
            .insert(schema.vulnerabilities)
            .values(withFindingIdentity([{ vulnId, source: "osv", severityLevel, cvssScore: 8.1 }]))
            .returning();
        return vuln!;
    }

    async function finding(componentId: string, vulnerabilityId: string) {
        await getTestDb().insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
        });
    }

    /**
     * The org runs `coredns` (image `registry.k8s.io/coredns/coredns:1.11.1`)
     * with log4j-core in its SBOM carrying CVE-2021-44228, plus an `api`
     * workload in a second cluster called `prod-eu`. A second org runs a
     * `coredns` workload of its own that must never show up.
     */
    async function seedFleet() {
        const db = getTestDb();
        const { org, cluster } = testData;
        const prodEu = await createCluster(db, org.id, { name: "prod-eu" });

        const coredns = await seedRunningImage(db, org.id, cluster.id, {
            namespace: "kube-system",
            workloadName: "coredns",
            digest: "sha256:" + "c".repeat(64),
        });
        await db
            .update(schema.images)
            .set({ registry: "registry.k8s.io", repository: "coredns/coredns" })
            .where(eqId(coredns.image.id));
        await db
            .update(schema.workloadContainers)
            .set({ imageRef: "registry.k8s.io/coredns/coredns:1.11.1", imageTag: "1.11.1" })
            .where(eqContainerId(coredns.container.id));

        const api = await seedRunningImage(db, org.id, prodEu.id, {
            namespace: "payments",
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
        });
        await db.update(schema.images).set({ registry: "ghcr.io", repository: "acme/nginx" }).where(eqId(api.image.id));
        await db
            .update(schema.workloadContainers)
            .set({ imageRef: "ghcr.io/acme/nginx:1.25.3", imageTag: "1.25.3" })
            .where(eqContainerId(api.container.id));

        const sbom = await createSbom(db, { imageId: coredns.image.id });
        const log4j = await component(sbom.id, "log4j-core", "2.14.1", "maven");
        await component(sbom.id, "log4j-api", "2.14.1", "maven");
        await component(sbom.id, "log4j-core", "2.17.0", "maven");
        const log4shell = await advisory("CVE-2021-44228", "critical");
        await finding(log4j.id, log4shell.id);

        const other = await createOrgWithOwner(
            getTestDb(),
            { email: "other@example.com" },
            { name: "Other", slug: "other" },
        );
        const otherCluster = await createCluster(db, other.org.id, { name: "prod-other" });
        const otherRun = await seedRunningImage(db, other.org.id, otherCluster.id, {
            namespace: "kube-system",
            workloadName: "coredns",
            digest: "sha256:" + "d".repeat(64),
        });
        const otherSbom = await createSbom(db, { imageId: otherRun.image.id });
        const otherLog4j = await component(otherSbom.id, "log4j-core", "2.14.1", "maven");
        await finding(otherLog4j.id, log4shell.id);

        return { prodEu, coredns, api, other, otherCluster, otherRun };
    }

    function groupOf(body: { groups: { kind: string; items: unknown[] }[] }, kind: string) {
        const g = body.groups.find((x) => x.kind === kind);
        if (!g) throw new Error(`no ${kind} group`);
        return g.items as Record<string, unknown>[];
    }

    it("puts vulnerabilities first and sets the direct hit for a lower-case CVE the org carries", async () => {
        const { coredns } = await seedFleet();

        const response = await request(app).get("/api/search").query({ q: "cve-2021-44228" }).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.intent).toBe("advisory");
        expect(response.body.directHit).toEqual({ kind: "vulnerability", vulnId: "CVE-2021-44228" });
        expect(response.body.groups.map((g: { kind: string }) => g.kind)).toEqual([
            "vulnerability",
            "package",
            "image",
            "container",
            "cluster",
        ]);
        const [row] = groupOf(response.body, "vulnerability");
        expect(row).toMatchObject({
            vulnId: "CVE-2021-44228",
            severity: "critical",
            exploited: false,
            kev: false,
            imageCount: 1,
            workloadCount: 1,
        });
        expect(coredns.image.orgId).toBe(testData.org.id);
    });

    it("returns no direct hit for an advisory the org does not carry", async () => {
        await seedFleet();
        await advisory("CVE-2020-0001");

        const response = await request(app).get("/api/search").query({ q: "CVE-2020-0001" }).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.intent).toBe("advisory");
        expect(response.body.directHit).toBeNull();
        expect(groupOf(response.body, "vulnerability")).toEqual([]);
    });

    it("puts images first for repo:tag and matches the pulled ref", async () => {
        const { api, prodEu } = await seedFleet();

        const response = await request(app).get("/api/search").query({ q: "nginx:1.25" }).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.intent).toBe("image");
        expect(response.body.groups[0].kind).toBe("image");
        expect(groupOf(response.body, "image")).toEqual([
            expect.objectContaining({
                id: api.image.id,
                registry: "ghcr.io",
                repository: "acme/nginx",
                tag: "1.25.3",
                clusterId: prodEu.id,
                clusterName: "prod-eu",
            }),
        ]);
    });

    it("puts packages first for a name, folded to one row per name, with the workload alongside", async () => {
        const { coredns } = await seedFleet();

        const response = await request(app).get("/api/search").query({ q: "log4j" }).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.intent).toBe("name");
        expect(response.body.groups[0].kind).toBe("package");
        expect(groupOf(response.body, "package")).toEqual([
            expect.objectContaining({
                name: "log4j-api",
                purlType: "maven",
                versionCount: 1,
                imageCount: 1,
                workloadCount: 1,
            }),
            expect.objectContaining({
                name: "log4j-core",
                purlType: "maven",
                versionCount: 2,
                imageCount: 1,
                workloadCount: 1,
            }),
        ]);

        const byWorkload = await request(app).get("/api/search").query({ q: "coredns" }).set(authHeaders());
        expect(groupOf(byWorkload.body, "container")).toEqual([
            expect.objectContaining({
                workloadId: coredns.workload.id,
                containerId: coredns.container.id,
                name: "coredns",
                kind: "Deployment",
                namespace: "kube-system",
                clusterId: testData.cluster.id,
                clusterName: testData.cluster.name,
            }),
        ]);
        expect(groupOf(byWorkload.body, "image")).toEqual([
            expect.objectContaining({ id: coredns.image.id, repository: "coredns/coredns", tag: "1.11.1" }),
        ]);
    });

    it("matches workloads by namespace and clusters by name", async () => {
        const { api, prodEu } = await seedFleet();

        const response = await request(app).get("/api/search").query({ q: "payments" }).set(authHeaders());
        expect(groupOf(response.body, "container")).toEqual([
            expect.objectContaining({ workloadId: api.workload.id, namespace: "payments" }),
        ]);

        const clusters = await request(app).get("/api/search").query({ q: "prod" }).set(authHeaders());
        expect(groupOf(clusters.body, "cluster")).toEqual([{ id: prodEu.id, name: "prod-eu" }]);
    });

    it("never shows another org's workload, image, cluster or finding", async () => {
        const { other } = await seedFleet();
        const headers = authHeaders({ ...other, cluster: testData.cluster, apiKey: testData.apiKey });

        const response = await request(app).get("/api/search").query({ q: "coredns" }).set(headers);

        expect(response.status).toBe(200);
        const workloads = groupOf(response.body, "container");
        expect(workloads).toHaveLength(1);
        expect(workloads[0]!.clusterName).toBe("prod-other");
        expect(groupOf(response.body, "image").every((i) => i.clusterName === "prod-other")).toBe(true);
        expect(groupOf(response.body, "cluster")).toEqual([]);

        const cve = await request(app).get("/api/search").query({ q: "CVE-2021-44228" }).set(headers);
        expect(groupOf(cve.body, "vulnerability")).toEqual([
            expect.objectContaining({ vulnId: "CVE-2021-44228", imageCount: 1, workloadCount: 1 }),
        ]);
    });

    it("caps every group at limit", async () => {
        await seedFleet();

        const response = await request(app).get("/api/search").query({ q: "log4j", limit: 1 }).set(authHeaders());

        expect(response.status).toBe(200);
        for (const group of response.body.groups) {
            expect(group.items.length).toBeLessThanOrEqual(1);
        }
        expect(groupOf(response.body, "package")).toEqual([expect.objectContaining({ name: "log4j-api" })]);
    });

    it("rejects a one-character term", async () => {
        const response = await request(app).get("/api/search").query({ q: "a" }).set(authHeaders());
        expect(response.status).toBe(400);

        const missing = await request(app).get("/api/search").set(authHeaders());
        expect(missing.status).toBe(400);

        const tooBig = await request(app).get("/api/search").query({ q: "ab", limit: 11 }).set(authHeaders());
        expect(tooBig.status).toBe(400);
    });

    it("returns five empty groups for an org with no clusters", async () => {
        const empty = await createOrgWithOwner(
            getTestDb(),
            { email: "empty@example.com" },
            { name: "Empty", slug: "empty" },
        );
        const headers = createInternalHeaders({
            id: empty.user.id,
            email: empty.user.email,
            orgId: empty.org.id,
            orgName: empty.org.name,
            orgSlug: empty.org.slug,
        });

        const response = await request(app).get("/api/search").query({ q: "anything" }).set(headers);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            query: "anything",
            intent: "name",
            directHit: null,
            groups: [
                { kind: "package", items: [] },
                { kind: "container", items: [] },
                { kind: "image", items: [] },
                { kind: "vulnerability", items: [] },
                { kind: "cluster", items: [] },
            ],
        });
    });
});

function eqId(id: string) {
    return eq(schema.images.id, id);
}
function eqContainerId(id: string) {
    return eq(schema.workloadContainers.id, id);
}
