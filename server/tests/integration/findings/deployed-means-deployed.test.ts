/**
 * Deployed means deployed: the `deployedImages*` predicates count an image
 * only while something runs it, plus a one-hour grace window for an SBOM that
 * lands just before the inventory report that deploys it.
 *
 * The bug these tests pin down: every rollout leaves the superseded digest's
 * `images` row behind for the GC's 30-day retention window, and the predicates
 * used to count those rows the whole time — so the Components tile climbed
 * ~900 per rollout and the risk trend *rose* on deploys that fixed CVEs.
 * Retention is not the bug and is deliberately untouched: the rolled-away
 * image stays in the database (and on the admin list, with its GC countdown);
 * it just counts for nothing while it waits.
 *
 * Fixture: one org, one cluster, three scanned images —
 *   (a) deployed:    has a `workload_containers` row.       Counted.
 *   (b) rolled away: no container, `first_seen_at` aged
 *       past the grace window, retained for GC.             Not counted.
 *   (c) fresh upload: no container yet, `first_seen_at`
 *       now — the upload-before-inventory case.             Counted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    withFindingIdentity,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

// Imported inside the tests rather than at the top: loading a repository loads
// `src/db`, which opens its pool from `DATABASE_URL` — and that is not pointed
// at the test container until the per-file `beforeAll` runs.
async function metricsRepository() {
    return (await import("../../../src/repositories/metrics.repository.js")).metricsRepository;
}
async function adminRepository() {
    return (await import("../../../src/repositories/admin.repository.js")).adminRepository;
}
async function adminExplorerRepository() {
    return (await import("../../../src/repositories/admin-explorer.repository.js")).adminExplorerRepository;
}
async function risk() {
    return import("../../../src/db/risk.js");
}

type Seeded = Awaited<ReturnType<typeof seedFixture>>;

const HOURS = 60 * 60 * 1_000;

async function seedFixture() {
    const db = getTestDb();
    const { user, org, cluster } = await seedTestScenario(db);

    const scan = async (
        imageId: string,
        componentCount: number,
        vulnId: string,
        severityLevel: string,
        cvssScore: number,
    ) => {
        const sbom = await createSbom(db, { imageId });
        const componentIds: string[] = [];
        for (let i = 0; i < componentCount; i++) {
            const [c] = await db
                .insert(schema.components)
                .values({
                    sbomId: sbom.id,
                    name: `lib-${vulnId}-${i}`,
                    version: "1.0.0",
                    purl: `pkg:npm/lib-${vulnId}-${i}@1.0.0`,
                    type: "library",
                    isDirect: true,
                })
                .returning();
            componentIds.push(c!.id);
        }
        const [vuln] = await db
            .insert(schema.vulnerabilities)
            .values(withFindingIdentity([{ vulnId, source: "osv", severityLevel, cvssScore }]))
            .returning();
        await db.insert(schema.componentVulnerabilities).values({
            componentId: componentIds[0]!,
            vulnerabilityId: vuln!.id,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
        });
    };

    // (a) Deployed: a container references it. 2 components, one high.
    // 7.4, not 7.5: unscored risks are cvss × 0.1, and 7.5 + 5.0 would put the
    // org sum exactly on 12.5 — where SQL round() (half-to-even on doubles)
    // and Math.round disagree. Off the edge, the two renderings agree.
    const { image: deployed } = await seedRunningImage(db, org.id, cluster.id, {
        workloadName: "api",
    });
    await scan(deployed.id, 2, "CVE-2026-1001", "high", 7.4);

    // (b) Rolled away: scanned, retained (recent `last_seen_at`), but nothing
    // references it and it is well past the grace window. Its finding is
    // *critical* so that any surface still counting it is unmissable.
    const rolledAway = await createImage(db, org.id, cluster.id);
    await scan(rolledAway.id, 3, "CVE-2026-1002", "critical", 9.8);
    await db
        .update(schema.images)
        .set({ firstSeenAt: new Date(Date.now() - 2 * HOURS) })
        .where(eq(schema.images.id, rolledAway.id));

    // (c) Fresh upload: SBOM landed, inventory has not caught up. 1 component,
    // one medium.
    const freshUpload = await createImage(db, org.id, cluster.id);
    await scan(freshUpload.id, 1, "CVE-2026-1003", "medium", 5.0);

    return { db, user, org, cluster, deployed, rolledAway, freshUpload };
}

// Images (a) + (c): 2 + 1 components, one high + one medium finding.
const EXPECTED_COMPONENTS = 3;
const EXPECTED_FINDINGS = { critical: 0, high: 1, medium: 1, low: 0, total: 2 };

describe("deployed means deployed", () => {
    let seeded: Seeded;

    beforeEach(async () => {
        await cleanAllData();
        seeded = await seedFixture();
    });

    it("counts org components and findings for deployed and fresh images only", async () => {
        const metrics = await metricsRepository();
        const snapshot = await metrics.computeCurrentMetrics(seeded.org.id);

        expect(snapshot.totalComponents).toBe(EXPECTED_COMPONENTS);
        expect(snapshot.criticalVulnerabilities).toBe(EXPECTED_FINDINGS.critical);
        expect(snapshot.highVulnerabilities).toBe(EXPECTED_FINDINGS.high);
        expect(snapshot.mediumVulnerabilities).toBe(EXPECTED_FINDINGS.medium);
        expect(snapshot.totalVulnerabilities).toBe(EXPECTED_FINDINGS.total);
    });

    it("counts cluster components and findings the same way", async () => {
        const metrics = await metricsRepository();
        const snapshot = await metrics.computeCurrentClusterMetrics(seeded.cluster.id);

        expect(snapshot.totalComponents).toBe(EXPECTED_COMPONENTS);
        expect(snapshot.criticalVulnerabilities).toBe(EXPECTED_FINDINGS.critical);
        expect(snapshot.totalVulnerabilities).toBe(EXPECTED_FINDINGS.total);
    });

    it("folds org risk over deployed and fresh images, not the rolled-away one", async () => {
        const { orgRiskRollup } = await risk();
        const { aggregateRisk } = await import("../../../src/db/risk-model.js");

        // The generated per-finding risks, straight off the advisory rows —
        // `aggregateRisk` over a subset of them is exactly what the org fold
        // computes for that subset.
        const rows = await seeded.db
            .select({
                vulnId: schema.vulnerabilities.vulnId,
                riskScore: schema.vulnerabilities.riskScore,
            })
            .from(schema.vulnerabilities);
        const riskOf = new Map(rows.map((r) => [r.vulnId, Number(r.riskScore)]));

        const deployedRisk = aggregateRisk([riskOf.get("CVE-2026-1001")!, riskOf.get("CVE-2026-1003")!]);
        const withRolledAway = aggregateRisk([...riskOf.values()]);

        // Non-zero first: agreeing on 0 would also pass with the fold broken.
        // And the rolled-away critical carries real risk, so counting it could
        // not go unnoticed by the equality.
        expect(deployedRisk).toBeGreaterThan(0);
        expect(withRolledAway).toBeGreaterThan(deployedRisk);

        const rollup = await orgRiskRollup(seeded.org.id);
        expect(rollup.findingCount).toBe(2);
        expect(rollup.score).toBe(deployedRisk);
    });

    it("folds cluster risk over the same population — the Overview equals the Radar Score tab", async () => {
        const { clusterRiskScores, orgRiskRollup } = await risk();

        const rollup = (await clusterRiskScores([seeded.cluster.id])).get(seeded.cluster.id)!;
        expect(rollup.findingCount).toBe(2);
        expect(rollup.score).toBeGreaterThan(0);

        // The org owns exactly one cluster, so the two folds must agree — the
        // composition `risk.ts` promises. The rolled-away image's critical is
        // the loudest possible tripwire: counting it (the bug where the
        // cluster fold scoped on `images.cluster_id` alone, so digests in GC
        // retention kept contributing) breaks both assertions at once.
        const org = await orgRiskRollup(seeded.org.id);
        expect(rollup.score).toBe(org.score);
    });

    it("lists deployed and fresh images in the SBOM Explorer, not the rolled-away one", async () => {
        const explorer = await adminExplorerRepository();
        const rows = await explorer.listExplorerImages(seeded.org.id);

        const ids = rows.map((r) => r.imageId).sort();
        expect(ids).toEqual([seeded.deployed.id, seeded.freshUpload.id].sort());
    });

    // Retention ≠ counting: the operator surface must keep showing the
    // rolled-away image and its GC countdown, or the queue becomes invisible.
    it("still shows the rolled-away image on the admin list with a GC countdown", async () => {
        const admin = await adminRepository();
        const page = await admin.listAdminImages({ limit: 200, offset: 0 });

        const row = page.images.find((i) => i.id === seeded.rolledAway.id);
        expect(row).toBeDefined();
        expect(row!.state).toBe("orphaned");
        expect(row!.gcInDays).toBeGreaterThan(0);
    });
});
