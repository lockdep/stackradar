import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import type { Tier } from "../../../src/lib/component-tier.js";
import {
    seedTestScenario,
    seedRunningImage,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * The tier lens (`db/finding-tier.ts`), one test per endpoint that lists or
 * counts findings (component tier plan, item 2). Every one of them must:
 *
 *   - accept `?tier=application,main` and list only that bucket …
 *   - … except that a KEV or EPSS ≥ 0.1 finding in the base image still
 *     lists, marked `shownDespiteTier: true`;
 *   - carry `tierCounts` for every bucket, computed without the lens, so the
 *     folded bucket is never invisible.
 *
 * One image, four findings:
 *
 *   lodash    application   CVE-2024-1001  high, idle, fixed
 *   libssl3   os            CVE-2024-1002  critical, idle, fixed   ← folded
 *   zlib1g    os            CVE-2024-1003  medium, on KEV          ← kept
 *   libc6     os            CVE-2024-1004  low, EPSS 0.3           ← kept
 */
describe("the tier lens on every findings endpoint", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;
    let imageId: string;
    let containerId: string;

    const LENS = "tier=application,main";
    const COUNTS = { application: 1, base: 3, all: 4 };

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);

        const running = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "api",
            digest: "sha256:" + "c".repeat(64),
        });
        imageId = running.image.id;
        containerId = running.container.id;
        const sbom = await createSbom(db, { imageId });

        const component = async (name: string, purl: string, tier: Tier) => {
            const [c] = await db
                .insert(schema.components)
                .values({
                    sbomId: sbom.id,
                    name,
                    version: "1.0.0",
                    purl,
                    type: "library",
                    isDirect: true,
                    tier,
                    tierVersion: 1,
                })
                .returning();
            return c!;
        };
        const advisory = async (
            vulnId: string,
            severityLevel: string,
            cvssScore: number,
            extra: { epssScore?: number; kevListedAt?: Date } = {},
        ) => {
            const [v] = await db
                .insert(schema.vulnerabilities)
                .values(
                    withFindingIdentity([
                        { vulnId, source: "osv", severityLevel, cvssScore, epssScore: 0.001, ...extra },
                    ]),
                )
                .returning();
            return v!;
        };
        const finding = (componentId: string, vulnerabilityId: string, fixedVersion: string | null) =>
            db.insert(schema.componentVulnerabilities).values({
                componentId,
                vulnerabilityId,
                matchedBy: "purl",
                matchType: "direct",
                matchConfidence: "exact",
                fixedVersion,
            });

        const lodash = await component("lodash", "pkg:npm/lodash@1.0.0", "application");
        const libssl = await component("libssl3", "pkg:deb/debian/libssl3@1.0.0?distro=debian-12", "os");
        const zlib = await component("zlib1g", "pkg:deb/debian/zlib1g@1.0.0?distro=debian-12", "os");
        const libc = await component("libc6", "pkg:deb/debian/libc6@1.0.0?distro=debian-12", "os");

        await finding(lodash.id, (await advisory("CVE-2024-1001", "high", 7.5)).id, "1.0.1");
        await finding(libssl.id, (await advisory("CVE-2024-1002", "critical", 9.8)).id, "1.0.2");
        await finding(
            zlib.id,
            (await advisory("CVE-2024-1003", "medium", 5.3, { kevListedAt: new Date("2024-02-01T00:00:00Z") })).id,
            null,
        );
        await finding(libc.id, (await advisory("CVE-2024-1004", "low", 3.1, { epssScore: 0.3 })).id, null);
    });

    function headers(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    const get = (url: string) => request(app).get(url).set(headers());

    /** `[vulnId, shownDespiteTier]`, sorted — order is each endpoint's own business. */
    const marks = (rows: { vulnId: string; shownDespiteTier: boolean }[]) =>
        rows.map((r) => [r.vulnId, r.shownDespiteTier] as const).sort((a, b) => a[0].localeCompare(b[0]));

    const EXPECTED_UNDER_LENS = [
        ["CVE-2024-1001", false],
        ["CVE-2024-1003", true],
        ["CVE-2024-1004", true],
    ];

    for (const [label, url] of [
        ["GET /api/vulnerabilities", () => "/api/vulnerabilities"],
        ["GET /api/clusters/:id/vulnerabilities", () => `/api/clusters/${testData.cluster.id}/vulnerabilities`],
    ] as const) {
        it(`${label} — filtered list, counts and the exploited override`, async () => {
            const all = await get(url());
            expect(all.status).toBe(200);
            expect(all.body.vulnerabilities).toHaveLength(4);
            expect(all.body.vulnerabilities.every((v: { shownDespiteTier: boolean }) => !v.shownDespiteTier)).toBe(
                true,
            );
            expect(all.body.tierCounts).toEqual(COUNTS);

            const lensed = await get(`${url()}?${LENS}`);
            expect(marks(lensed.body.vulnerabilities)).toEqual(EXPECTED_UNDER_LENS);
            expect(lensed.body.total).toBe(3);
            expect(lensed.body.totalFindings).toBe(3);
            expect(lensed.body.tierCounts).toEqual(COUNTS);

            const base = await get(`${url()}?tier=os,runtime`);
            expect(marks(base.body.vulnerabilities).map(([id]) => id)).toEqual([
                "CVE-2024-1002",
                "CVE-2024-1003",
                "CVE-2024-1004",
            ]);

            // Unknown values are ignored; nothing recognisable is no lens.
            const junk = await get(`${url()}?tier=banana`);
            expect(junk.body.vulnerabilities).toHaveLength(4);
        });

        it(`${label} — the bucket counts follow the severity filter, not the lens`, async () => {
            const res = await get(`${url()}?${LENS}&severity=critical,high`);
            expect(marks(res.body.vulnerabilities)).toEqual([["CVE-2024-1001", false]]);
            expect(res.body.tierCounts).toEqual({ application: 1, base: 1, all: 2 });
        });

        it(`${label}/occurrences and /detail — lensed, with the identity's counts`, async () => {
            const folded = await get(`${url()}/occurrences?identity=CVE-2024-1002&${LENS}`);
            expect(folded.status).toBe(200);
            expect(folded.body.images).toEqual([]);
            expect(folded.body.tierCounts).toEqual({ application: 0, base: 1, all: 1 });

            const kept = await get(`${url()}/occurrences?identity=CVE-2024-1003&${LENS}`);
            expect(kept.body.images).toHaveLength(1);

            const detail = await get(`${url()}/detail?identity=CVE-2024-1002&${LENS}`);
            expect(detail.body.advisories).toHaveLength(1);
            expect(detail.body.fixes).toEqual([]);
            expect(detail.body.tierCounts).toEqual({ application: 0, base: 1, all: 1 });

            const unlensed = await get(`${url()}/detail?identity=CVE-2024-1002`);
            expect(unlensed.body.fixes).toEqual([{ packageName: "libssl3", fixedVersion: "1.0.2" }]);
        });
    }

    it("GET /api/radar-score/findings and the cluster twin", async () => {
        for (const url of [
            `/api/radar-score/findings?imageId=${imageId}`,
            `/api/clusters/${testData.cluster.id}/radar-score/findings?imageId=${imageId}`,
        ]) {
            const all = await get(url);
            expect(all.body.findings).toHaveLength(4);
            expect(all.body.tierCounts).toEqual(COUNTS);

            const lensed = await get(`${url}&${LENS}`);
            expect(marks(lensed.body.findings)).toEqual(EXPECTED_UNDER_LENS);
            expect(lensed.body.tierCounts).toEqual(COUNTS);
        }
    });

    it("GET …/vulnerabilities/grouped — the image page and the container page", async () => {
        for (const url of [
            `/api/images/${imageId}/vulnerabilities/grouped`,
            `/api/containers/${containerId}/vulnerabilities/grouped`,
        ]) {
            const all = await get(url);
            expect(all.status).toBe(200);
            expect(all.body.summary.total).toBe(4);
            expect(all.body.tierCounts).toEqual(COUNTS);

            const lensed = await get(`${url}?${LENS}`);
            expect(lensed.body.summary.total).toBe(3);
            expect(lensed.body.tierCounts).toEqual(COUNTS);
            const rows = lensed.body.groups.flatMap(
                (g: { vulnerabilities: { vulnId: string; shownDespiteTier: boolean }[] }) => g.vulnerabilities,
            );
            expect(marks(rows)).toEqual(EXPECTED_UNDER_LENS);
        }
    });

    it("the fixes rollup's fixableByYou", async () => {
        const { fixRollupForOrg } = await import("../../../src/services/remediation-rollup.service.js");
        const rollup = await fixRollupForOrg(testData.org.id);
        expect(rollup.rows[0]!.findings).toMatchObject({ total: 4, fixable: 2, fixableByYou: 1 });
        expect(rollup.totals.findings).toMatchObject({ fixable: 2, fixableByYou: 1 });
    });

    it("GET /api/search — package rows carry the base tag, and take the lens", async () => {
        const all = await get("/api/search?q=li");
        const packages = all.body.groups.find((g: { kind: string }) => g.kind === "package").items as {
            name: string;
            base: boolean;
        }[];
        expect(Object.fromEntries(packages.map((p) => [p.name, p.base]))).toMatchObject({
            libssl3: true,
            libc6: true,
            zlib1g: true,
        });

        const lodash = await get("/api/search?q=lodash");
        expect(lodash.body.groups.find((g: { kind: string }) => g.kind === "package").items[0]).toMatchObject({
            name: "lodash",
            base: false,
        });

        const lensed = await get(`/api/search?q=li&${LENS}`);
        expect(lensed.body.groups.find((g: { kind: string }) => g.kind === "package").items).toEqual([]);
        const vulns = await get(`/api/search?q=CVE-2024-100&${LENS}`);
        expect(
            vulns.body.groups
                .find((g: { kind: string }) => g.kind === "vulnerability")
                .items.map((v: { vulnId: string }) => v.vulnId)
                .sort(),
        ).toEqual(["CVE-2024-1001", "CVE-2024-1003", "CVE-2024-1004"]);
    });

    it("GET /api/feed/movement — answers the lens from the event's own counts", async () => {
        const bands = (critical = 0, high = 0) => ({ critical, high, medium: 0, low: 0, unscored: 0 });
        await getTestDb()
            .insert(schema.activityEvents)
            .values({
                orgId: testData.org.id,
                clusterId: testData.cluster.id,
                type: "scan.findings-changed",
                imageId,
                payload: {
                    cause: "mirror",
                    containerCount: 1,
                    addedBySeverity: bands(1, 1),
                    addedByLens: { application: bands(0, 1), base: bands(1, 0) },
                    added: [
                        {
                            key: "library|lodash|CVE-2024-1001",
                            vulnId: "CVE-2024-1001",
                            packageName: "lodash",
                            packageType: "library",
                            severityLevel: "high",
                            bucket: "application",
                            exploited: false,
                        },
                        {
                            key: "library|libssl3|CVE-2024-1002",
                            vulnId: "CVE-2024-1002",
                            packageName: "libssl3",
                            packageType: "library",
                            severityLevel: "critical",
                            bucket: "base",
                            exploited: false,
                        },
                    ],
                    removed: [],
                },
            });

        const all = await get("/api/feed/movement");
        expect(all.body.images[0].addedCount).toBe(2);
        expect(all.body.tierCounts).toEqual({ application: 1, base: 1, all: 2 });

        const lensed = await get(`/api/feed/movement?${LENS}`);
        expect(lensed.body.images[0].added).toMatchObject({ critical: 0, high: 1 });

        const unfolded = await get(`/api/feed/movement/${imageId}/findings?${LENS}`);
        expect(unfolded.body.findings.map((f: { vulnId: string }) => f.vulnId)).toEqual(["CVE-2024-1001"]);
        expect(unfolded.body.tierCounts).toEqual({ application: 1, base: 1, all: 2 });
    });
});
