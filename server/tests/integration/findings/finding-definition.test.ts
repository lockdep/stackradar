/**
 * One definition of a finding, checked across every surface that reports one.
 *
 * The bug these tests exist for: a Grafana workload whose cluster dashboard
 * said 195 criticals, whose trend chart said 17, and whose own Vulnerabilities
 * tab listed 14. Three queries, three answers, all from the same rows. The
 * fixture below is that shape in miniature — an unconfirmed match, a pair of
 * aliased advisories, and an advisory published under a package name the
 * component does not carry — and every assertion here is some surface being
 * asked to agree with the others.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, seedRunningImage, createSbom, withFindingIdentity } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

// Imported inside the test rather than at the top: loading a repository loads
// `src/db`, which opens its pool from `DATABASE_URL` — and that is not pointed
// at the test container until the per-file `beforeAll` runs.
async function metricsRepository() {
    return (await import("../../../src/repositories/metrics.repository.js")).metricsRepository;
}

type Seeded = Awaited<ReturnType<typeof seedFixture>>;

/**
 * A workload carrying one of each interesting case.
 *
 * Expected findings: four. One critical (the advisory whose package name the
 * component does not share), one high (a GHSA and a GO- record that are the
 * same CVE, collapsed, keeping the higher severity), one medium, and one more
 * critical that reaches two Debian binaries of one source package under a
 * tracker entry *and* the security notice that fixes it — four rows, one
 * finding. The unconfirmed critical is not a finding at all.
 */
async function seedFixture() {
    const db = getTestDb();
    const { user, org, cluster } = await seedTestScenario(db);
    const { image, container } = await seedRunningImage(db, org.id, cluster.id, {
        workloadName: "grafana",
        containerName: "grafana",
    });
    // No `isCurrent` to set. One SBOM per image, enforced by
    // `sboms_image_id_unique`, is what the flag used to approximate.
    const sbom = await createSbom(db, { imageId: image.id });

    const component = async (name: string, version: string, purl: string) => {
        const [c] = await db
            .insert(schema.components)
            .values({ sbomId: sbom.id, name, version, purl, type: "library", isDirect: true })
            .returning();
        return c!;
    };

    const advisory = async (
        vulnId: string,
        severityLevel: string | null,
        cvssScore: number | null,
        aliases: string[] | null,
        osv: { related?: string[]; upstream?: string[] } = {},
    ) => {
        const [v] = await db
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    {
                        vulnId,
                        source: "osv",
                        severityLevel,
                        cvssScore,
                        aliases,
                        related: osv.related ?? [],
                        rawData: osv.upstream ? { upstream: osv.upstream } : null,
                    },
                ]),
            )
            .returning();
        return v!;
    };

    const affects = async (vulnerabilityId: string, packageName: string, ecosystem: string) => {
        await db.insert(schema.vulnerabilityAffectedPackages).values({
            vulnerabilityId,
            packageName,
            ecosystem,
            matchKey: `${ecosystem}:${packageName}`.toLowerCase(),
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.9.9" }] }],
            generation: 1,
        });
    };

    const link = async (
        componentId: string,
        vulnerabilityId: string,
        matchConfidence: "exact" | "fuzzy" | "unconfirmed",
        upstreamName: string | null = null,
    ) => {
        await db.insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: upstreamName ? "indirect" : "direct",
            matchConfidence,
            upstreamName,
        });
    };

    // 1. The submodule case. The SBOM names the component for its subpath; the
    //    advisory is published against the module. The matcher resolves that
    //    from the PURL, a join on component name never can.
    const pyroscope = await component(
        "github.com/grafana/pyroscope/api",
        "v1.2.1",
        "pkg:golang/github.com/grafana/pyroscope@v1.2.1#api",
    );
    const submoduleAdvisory = await advisory("GHSA-m9hq-h476-h2g8", "critical", 9.8, ["CVE-2025-41118"]);
    await affects(submoduleAdvisory.id, "github.com/grafana/pyroscope", "Go");
    await link(pyroscope.id, submoduleAdvisory.id, "exact");

    // 2. Two advisories, one vulnerability. Collapse keeps the higher severity.
    const lodash = await component("lodash", "4.17.20", "pkg:npm/lodash@4.17.20");
    const ghsa = await advisory("GHSA-aaaa-bbbb-cccc", "high", 7.5, ["CVE-2024-1111"]);
    const goRecord = await advisory("GO-2024-0001", "unknown", null, ["CVE-2024-1111"]);
    await affects(ghsa.id, "lodash", "npm");
    await affects(goRecord.id, "lodash", "npm");
    await link(lodash.id, ghsa.id, "exact");
    await link(lodash.id, goRecord.id, "exact");

    // 3. The package matched but the version question was unanswerable. Stored,
    //    never counted — this is the row type that inflated the dashboard.
    const unconfirmed = await advisory("CVE-2024-2222", "critical", 9.1, null);
    await affects(unconfirmed.id, "lodash", "npm");
    await link(lodash.id, unconfirmed.id, "unconfirmed");

    // 4. An ordinary confirmed finding.
    const openssl = await component("openssl", "3.0.1", "pkg:generic/openssl@3.0.1");
    const medium = await advisory("CVE-2024-3333", "medium", 5.4, null);
    await affects(medium.id, "openssl", "OSS-Fuzz");
    await link(openssl.id, medium.id, "exact");

    // 5. One Debian source package, two binaries, and the whole Ubuntu feed
    //    shape: the tracker entry (`UBUNTU-CVE-…`, its CVE under `upstream`)
    //    matched on both binaries through `upstream=glibc`, and the notice
    //    that fixes it (`USN-…`, no CVSS, the entry under `related`) matched
    //    on both as well. Four rows; one thing to fix; one finding.
    const libc6 = await component("libc6", "2.39-0ubuntu8.7", "pkg:deb/ubuntu/libc6@2.39-0ubuntu8.7?upstream=glibc");
    const libcBin = await component(
        "libc-bin",
        "2.39-0ubuntu8.7",
        "pkg:deb/ubuntu/libc-bin@2.39-0ubuntu8.7?upstream=glibc",
    );
    const tracker = await advisory("UBUNTU-CVE-2024-4444", "critical", 9.8, null, {
        upstream: ["CVE-2024-4444"],
        related: ["USN-7000-1"],
    });
    const notice = await advisory("USN-7000-1", "unknown", null, null, {
        upstream: ["CVE-2024-4444", "CVE-2024-5555", "UBUNTU-CVE-2024-4444"],
        related: ["UBUNTU-CVE-2024-4444"],
    });
    await affects(tracker.id, "glibc", "Ubuntu:24.04:LTS");
    await affects(notice.id, "glibc", "Ubuntu:24.04:LTS");
    for (const binary of [libc6, libcBin]) {
        await link(binary.id, tracker.id, "exact", "glibc");
        await link(binary.id, notice.id, "exact", "glibc");
    }

    return { db, user, org, cluster, image, container, sbom };
}

const EXPECTED = { critical: 2, high: 1, medium: 1, low: 0 };
const EXPECTED_TOTAL = 4;

describe("what counts as a finding", () => {
    let app: Express;
    let seeded: Seeded;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        seeded = await seedFixture();
    });

    function authHeaders() {
        const { user, org } = seeded;
        return createInternalHeaders({
            id: user.id,
            email: user.email,
            orgId: org.id,
            orgName: org.name,
            orgSlug: org.slug,
        });
    }

    it("counts the same findings on the cluster dashboard's workload list", async () => {
        const res = await request(app).get("/api/containers").set(authHeaders());

        expect(res.status).toBe(200);
        const workload = res.body.find((w: { id: string }) => w.id === seeded.container.id);
        expect(workload.vulnerabilities).toEqual(EXPECTED);
    });

    it("counts the same findings on the workload's own header", async () => {
        const res = await request(app).get(`/api/containers/${seeded.container.id}`).set(authHeaders());

        expect(res.status).toBe(200);
        expect(res.body.vulnerabilities).toEqual(EXPECTED);
    });

    it("lists the same findings on the workload's Vulnerabilities tab", async () => {
        const res = await request(app)
            .get(`/api/containers/${seeded.container.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        expect(res.status).toBe(200);
        expect(res.body.summary).toMatchObject({ ...EXPECTED, total: EXPECTED_TOTAL });

        const listed = res.body.groups.flatMap((g: { vulnerabilities: { vulnId: string }[] }) =>
            g.vulnerabilities.map((v) => v.vulnId),
        );
        expect(listed).toHaveLength(EXPECTED_TOTAL);
    });

    it("lists the same findings on the image page", async () => {
        const res = await request(app).get(`/api/images/${seeded.image.id}/vulnerabilities/grouped`).set(authHeaders());

        expect(res.status).toBe(200);
        expect(res.body.summary).toMatchObject({ ...EXPECTED, total: EXPECTED_TOTAL });

        const listed = res.body.groups.flatMap((g: { vulnerabilities: { vulnId: string }[] }) =>
            g.vulnerabilities.map((v) => v.vulnId),
        );
        expect(listed).toHaveLength(EXPECTED_TOTAL);
        // No container to read a tag off — the block says so rather than guessing.
        expect(res.body.currentSbom).toMatchObject({ imageTag: null, imageRef: null });
    });

    it("counts the same findings in the metrics behind the trend charts", async () => {
        const metrics = await metricsRepository();
        const [org, cluster] = await Promise.all([
            metrics.computeCurrentMetrics(seeded.org.id),
            metrics.computeCurrentClusterMetrics(seeded.cluster.id),
        ]);

        for (const snapshot of [org, cluster]) {
            expect(snapshot.criticalVulnerabilities).toBe(EXPECTED.critical);
            expect(snapshot.highVulnerabilities).toBe(EXPECTED.high);
            expect(snapshot.mediumVulnerabilities).toBe(EXPECTED.medium);
            expect(snapshot.lowVulnerabilities).toBe(EXPECTED.low);
            expect(snapshot.totalVulnerabilities).toBe(EXPECTED_TOTAL);
        }
    });

    it("snapshots the same risk score the cluster header reports", async () => {
        const metrics = await metricsRepository();
        const { clusterRiskScores } = await import("../../../src/db/risk.js");

        const snapshot = await metrics.computeCurrentClusterMetrics(seeded.cluster.id);
        const rollup = (await clusterRiskScores([seeded.cluster.id])).get(seeded.cluster.id);

        // Non-zero first: agreeing on 0 would also pass with the fold broken.
        expect(snapshot.riskScore).toBeGreaterThan(0);
        expect(snapshot.riskScore).toBe(Math.round(rollup?.score ?? 0));
    });

    it("does not report a match whose version could not be confirmed", async () => {
        const res = await request(app)
            .get(`/api/containers/${seeded.container.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        const listed = res.body.groups.flatMap((g: { vulnerabilities: { vulnId: string }[] }) =>
            g.vulnerabilities.map((v) => v.vulnId),
        );
        expect(listed).not.toContain("CVE-2024-2222");
    });

    // The regression the read path used to cause: it re-derived the verdict by
    // joining advisories on component *name*, so an advisory published against
    // the parent module vanished from the page while still being counted on the
    // dashboard. Confirmed by the matcher means shown.
    it("reports a confirmed finding whose advisory names the parent module", async () => {
        const res = await request(app)
            .get(`/api/containers/${seeded.container.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        const listed = res.body.groups.flatMap((g: { vulnerabilities: { vulnId: string }[] }) =>
            g.vulnerabilities.map((v) => v.vulnId),
        );
        expect(listed).toContain("GHSA-m9hq-h476-h2g8");
        expect(res.body.summary.critical).toBe(EXPECTED.critical);
    });

    it("counts a CVE once across the binaries of one source package", async () => {
        const res = await request(app)
            .get(`/api/containers/${seeded.container.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        const glibc = res.body.groups.filter(
            (g: { componentName: string }) => g.componentName === "libc6" || g.componentName === "libc-bin",
        );
        const listed = glibc.flatMap((g: { vulnerabilities: { vulnId: string }[] }) =>
            g.vulnerabilities.map((v) => v.vulnId),
        );
        expect(listed).toEqual(["UBUNTU-CVE-2024-4444"]);
    });

    it("does not count a security notice beside the CVE record it fixes", async () => {
        const res = await request(app)
            .get(`/api/containers/${seeded.container.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        const findings = res.body.groups.flatMap(
            (g: { vulnerabilities: { vulnId: string; aliasIds: string[] }[] }) => g.vulnerabilities,
        );
        expect(findings.map((f: { vulnId: string }) => f.vulnId)).not.toContain("USN-7000-1");
        // …but the finding it was folded into says so.
        const tracker = findings.find((f: { vulnId: string }) => f.vulnId === "UBUNTU-CVE-2024-4444");
        expect(tracker.aliasIds).toEqual(["USN-7000-1"]);
        expect(res.body.summary.unscored).toBe(0);
    });

    it("counts two advisories for one CVE once, at the higher severity", async () => {
        const res = await request(app)
            .get(`/api/containers/${seeded.container.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        const lodash = res.body.groups.find((g: { componentName: string }) => g.componentName === "lodash");
        expect(lodash.vulnerabilities).toHaveLength(1);
        expect(lodash.vulnerabilities[0].vulnId).toBe("GHSA-aaaa-bbbb-cccc");
        expect(lodash.vulnerabilities[0].aliasIds).toEqual(["GO-2024-0001"]);
        expect(lodash.counts).toMatchObject({ critical: 0, high: 1 });
    });

    it("says 'not known yet' rather than zero when nothing has scanned the workload", async () => {
        const db = getTestDb();
        const { image, container } = await seedRunningImage(db, seeded.org.id, seeded.cluster.id, {
            workloadName: "never-scanned",
        });
        await createSbom(db, { imageId: image.id });

        const res = await request(app).get("/api/containers").set(authHeaders());
        const workload = res.body.find((w: { id: string }) => w.id === container.id);

        expect(workload.vulnerabilities).toBeNull();
    });

    it("says zero rather than 'not known yet' once a scan has found nothing", async () => {
        const db = getTestDb();
        const { image, container } = await seedRunningImage(db, seeded.org.id, seeded.cluster.id, {
            workloadName: "clean",
        });
        const sbom = await createSbom(db, { imageId: image.id });
        await db.insert(schema.vulnerabilityScanRuns).values({
            orgId: seeded.org.id,
            imageId: image.id,
            sbomId: sbom.id,
            trigger: "manual",
            status: "success",
        });

        const res = await request(app).get("/api/containers").set(authHeaders());
        const workload = res.body.find((w: { id: string }) => w.id === container.id);

        expect(workload.vulnerabilities).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });
});
