/**
 * Rolling risk up from findings to the rows a person looks at.
 *
 * `risk-model-parity.test.ts` covers the arithmetic. This file covers the
 * joins, and specifically the two ways they can be wrong:
 *
 *  - **Multiplying.** An image running as two containers of one workload, or in
 *    two workloads of one release, must not have its findings counted twice.
 *    This is the same trap `deployedImages` in `findings.ts` exists for, one
 *    layer up, and it inflates exactly the workloads that are hardest to reason
 *    about — the ones mid-rollout.
 *  - **Composing.** Since ADR 0007 the aggregate is a plain sum, so a
 *    workload's score must equal the sum of its distinct images' scores — the
 *    dedup above is what keeps that equality honest.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    createHelmRelease,
    createWorkloadContainer,
    withFindingIdentity,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { advisoryRisk, aggregateRisk } from "../../../src/db/risk-model.js";

type Risk = typeof import("../../../src/db/risk.js");

/** Loaded late — importing it opens the pool from `DATABASE_URL`. */
async function risk(): Promise<Risk> {
    return import("../../../src/db/risk.js");
}

/**
 * One advisory and one vulnerable component on an image, with a chosen risk.
 *
 * The CVSS/EPSS pair is picked so `advisoryRisk` lands near `targetRisk`; the
 * assertions compare against the formula rather than the target, so the
 * approximation is a convenience and never the thing under test.
 */
async function addFinding(
    imageId: string,
    sbomId: string,
    opts: { vulnId: string; packageName: string; cvss: number; epss?: number | null; kev?: boolean },
) {
    const db = getTestDb();
    const [component] = await db
        .insert(schema.components)
        .values({
            sbomId,
            name: opts.packageName,
            version: "1.0.0",
            purl: `pkg:npm/${opts.packageName}@1.0.0`,
            type: "library",
            isDirect: true,
        })
        .returning();

    const [advisory] = await db
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId: opts.vulnId,
                    source: "osv",
                    cvssScore: opts.cvss,
                    severityLevel: opts.cvss >= 9 ? "critical" : opts.cvss >= 7 ? "high" : "medium",
                    epssScore: opts.epss ?? null,
                    kevListedAt: opts.kev ? new Date("2021-12-10") : null,
                    aliases: [],
                },
            ]),
        )
        .returning();

    await db.insert(schema.componentVulnerabilities).values({
        componentId: component!.id,
        vulnerabilityId: advisory!.id,
        matchedBy: "purl",
        matchType: "direct",
        matchConfidence: "exact",
    });

    return { component: component!, advisory: advisory!, imageId };
}

describe("risk rollups", () => {
    beforeAll(async () => {
        await cleanAllData();
    });

    beforeEach(async () => {
        await cleanAllData();
    });

    it("scores an image from its findings", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { image } = await seedRunningImage(db, org.id, cluster.id);
        const sbom = await createSbom(db, { imageId: image.id });

        await addFinding(image.id, sbom.id, {
            vulnId: "CVE-2021-44228",
            packageName: "log4j",
            cvss: 10,
            epss: 0.97,
            kev: true,
        });
        await addFinding(image.id, sbom.id, {
            vulnId: "CVE-2024-0001",
            packageName: "quiet",
            cvss: 9.8,
            epss: 0.0004,
        });

        const { imageRiskScores } = await risk();
        const scores = await imageRiskScores([image.id]);
        const rollup = scores.get(image.id)!;

        const expected = aggregateRisk([
            advisoryRisk({ cvssScore: 10, epssScore: 0.97, kevListedAt: new Date() }),
            advisoryRisk({ cvssScore: 9.8, epssScore: 0.0004 }),
        ]);

        expect(rollup.score).toBeCloseTo(expected, 1);
        expect(rollup.findingCount).toBe(2);
        expect(rollup.kevCount).toBe(1);
        expect(rollup.band).toBe("critical");
        // The "why" a ranked row has to be able to show.
        expect(rollup.topFinding?.vulnId).toBe("CVE-2021-44228");
    });

    it("counts a digest mounted twice in one workload once", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { image, workload } = await seedRunningImage(db, org.id, cluster.id, {
            containerName: "app",
        });
        const sbom = await createSbom(db, { imageId: image.id });
        await addFinding(image.id, sbom.id, {
            vulnId: "CVE-2024-0002",
            packageName: "shared",
            cvss: 7.5,
            epss: 0.5,
        });

        const { workloadRiskScores } = await risk();
        const before = (await workloadRiskScores([workload.id]))!.get(workload.id)!;

        // The init container that seeds a volume from the same image the main
        // container serves from. One finding, two containers.
        await createWorkloadContainer(db, org.id, workload.id, image.id, {
            name: "init-config",
            init: true,
        });

        const after = (await workloadRiskScores([workload.id]))!.get(workload.id)!;

        expect(after.findingCount).toBe(1);
        expect(after.findingCount).toBe(before.findingCount);
        expect(after.score).toBeCloseTo(before.score, 5);
    });

    it("counts a mid-rollout workload's two digests as two finding sets", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { image: oldImage, workload } = await seedRunningImage(db, org.id, cluster.id);
        const oldSbom = await createSbom(db, { imageId: oldImage.id });
        await addFinding(oldImage.id, oldSbom.id, {
            vulnId: "CVE-2024-0003",
            packageName: "old-pkg",
            cvss: 9.1,
            epss: 0.6,
        });

        // Same container name, different digest — the legal state that
        // `workload_containers_identity_unique` exists to represent.
        const newImage = await createImage(db, org.id, cluster.id, { repository: "acme/api" });
        const newSbom = await createSbom(db, { imageId: newImage.id });
        await addFinding(newImage.id, newSbom.id, {
            vulnId: "CVE-2024-0004",
            packageName: "new-pkg",
            cvss: 5.3,
            epss: 0.1,
        });
        await createWorkloadContainer(db, org.id, workload.id, newImage.id, { name: "app" });

        const { workloadRiskScores } = await risk();
        const rollup = (await workloadRiskScores([workload.id]))!.get(workload.id)!;

        // Both digests are serving traffic, so both sets of findings are live.
        expect(rollup.findingCount).toBe(2);
        expect(rollup.topFinding?.vulnId).toBe("CVE-2024-0003");
    });

    it("makes a workload's score the sum of its distinct images' scores", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        // Two images, each carrying one identical finding. The sum composes:
        // the workload is exactly both images together, which is the property
        // the Dashboard's org total and the cluster totals rest on (ADR 0007).
        const { image: first, workload } = await seedRunningImage(db, org.id, cluster.id);
        const firstSbom = await createSbom(db, { imageId: first.id });
        await addFinding(first.id, firstSbom.id, {
            vulnId: "CVE-2024-0005",
            packageName: "a",
            cvss: 10,
            epss: 1,
        });

        const second = await createImage(db, org.id, cluster.id, { repository: "acme/sidecar" });
        const secondSbom = await createSbom(db, { imageId: second.id });
        await addFinding(second.id, secondSbom.id, {
            vulnId: "CVE-2024-0006",
            packageName: "b",
            cvss: 10,
            epss: 1,
        });
        await createWorkloadContainer(db, org.id, workload.id, second.id, { name: "sidecar" });

        const { imageRiskScores, workloadRiskScores } = await risk();
        const images = await imageRiskScores([first.id, second.id]);
        const rollup = (await workloadRiskScores([workload.id]))!.get(workload.id)!;

        const one = advisoryRisk({ cvssScore: 10, epssScore: 1 });
        expect(rollup.score).toBeCloseTo(aggregateRisk([one, one]), 1);

        const composed = images.get(first.id)!.score + images.get(second.id)!.score;
        expect(rollup.score).toBeCloseTo(composed, 0);
    });

    it("scores a release across every workload the chart deploys", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "kube-prometheus-stack",
            chartName: "kube-prometheus-stack",
            chartVersion: "82.18.0",
        });

        // Two workloads of one release, in two namespaces — the case that a
        // namespace-keyed rollup would split into two releases.
        const a = await seedRunningImage(db, org.id, cluster.id, {
            namespace: "monitoring",
            workloadName: "prometheus",
            releaseId: release.id,
        });
        const b = await seedRunningImage(db, org.id, cluster.id, {
            namespace: "kube-system",
            workloadName: "node-exporter",
            releaseId: release.id,
        });

        const aSbom = await createSbom(db, { imageId: a.image.id });
        const bSbom = await createSbom(db, { imageId: b.image.id });
        await addFinding(a.image.id, aSbom.id, {
            vulnId: "CVE-2024-0007",
            packageName: "p",
            cvss: 8.1,
            epss: 0.4,
        });
        await addFinding(b.image.id, bSbom.id, {
            vulnId: "CVE-2024-0008",
            packageName: "q",
            cvss: 6.5,
            epss: 0.2,
        });

        const { releaseRiskScores } = await risk();
        const rollup = (await releaseRiskScores([release.id]))!.get(release.id)!;

        expect(rollup.findingCount).toBe(2);
        expect(rollup.topFinding?.vulnId).toBe("CVE-2024-0007");
    });

    it("returns nothing for rows with no findings rather than a zero row", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { workload } = await seedRunningImage(db, org.id, cluster.id);

        const { workloadRiskScores, emptyRiskRollup } = await risk();
        const scores = await workloadRiskScores([workload.id]);

        // A clean workload and an unscanned one are different states, and the
        // map is the wrong place to decide which this is — the caller knows
        // whether an SBOM exists and substitutes `emptyRiskRollup()` when it
        // does. Asserting the absence keeps that decision at the call site.
        expect(scores.has(workload.id)).toBe(false);
        expect(emptyRiskRollup().score).toBe(0);
    });

    it("is deterministic when findings tie on risk", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { image, workload } = await seedRunningImage(db, org.id, cluster.id);
        const sbom = await createSbom(db, { imageId: image.id });

        // The common shape on a base image: a dozen unscored advisories that
        // all land on exactly the same number. A sum is order-free, so the
        // score is trivially stable — this pins it against a future fold that
        // reintroduces order-sensitivity.
        for (let i = 0; i < 12; i++) {
            await addFinding(image.id, sbom.id, {
                vulnId: `GHSA-tie-${i}`,
                packageName: `pkg-${i}`,
                cvss: 7.5,
                epss: null,
            });
        }

        const { workloadRiskScores } = await risk();
        const runs = await Promise.all(
            Array.from({ length: 5 }, async () => (await workloadRiskScores([workload.id]))!.get(workload.id)!.score),
        );
        expect(new Set(runs).size).toBe(1);
    });
});
