/**
 * The admin dashboard's withdrawn-advisory figures.
 *
 * Two separate claims are pinned here, because they fail in opposite directions:
 *
 * 1. `getWithdrawnStats()` must *find* the problems. A finding matched before
 *    its advisory was retracted is still served to the customer — the matcher
 *    only refuses to create such a match, nothing retracts one — and an
 *    affected-package row whose denormalised `withdrawn` flag disagrees with
 *    the advisory is still inside `vuln_affected_pkg_match_key_idx`, which is
 *    partial on `withdrawn = false` precisely to exclude it. Both are invisible
 *    without a number, so these assertions are the number.
 *
 * 2. Every other mirror figure must *exclude* withdrawn advisories. Those
 *    numbers are read as "what the matcher can work with", and the matcher
 *    cannot work with a retraction.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load, and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createImage, createSbom, withFindingIdentity } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let adminRepository: typeof import("../../../src/repositories/admin.repository.js").adminRepository;

beforeAll(async () => {
    adminRepository = (await import("../../../src/repositories/admin.repository.js")).adminRepository;
});

const WITHDRAWN_AT = new Date("2026-01-15T00:00:00Z");

beforeEach(async () => {
    // cleanAllData clears component_vulnerabilities itself. osv_sync_state is
    // not in it — nothing else in the suite writes that table.
    await getTestDb().delete(schema.osvSyncState);
    await cleanAllData();
});

/**
 * One active advisory and one retracted one, with a customer component matched
 * against both — the retracted match standing in for one made before the
 * withdrawal landed.
 *
 * The retracted advisory gets three affected-package rows: one correctly
 * flagged, one drifted (flag still false while the advisory is withdrawn), and
 * one drifted row parked in a non-current generation, which every read must
 * ignore.
 */
async function seedWithdrawnScenario() {
    const db = getTestDb();
    const { org, cluster } = await seedTestScenario(db);
    const image = await createImage(db, org.id, cluster.id);
    const sbom = await createSbom(db, { imageId: image.id });

    const [component] = await db.insert(schema.components).values({
        sbomId: sbom.id,
        name: "lodash",
        version: "4.17.20",
        type: "library",
        purl: "pkg:npm/lodash@4.17.20",
    }).returning();

    const [active] = await db.insert(schema.vulnerabilities).values(withFindingIdentity([{
        vulnId: "CVE-2024-0001",
        source: "osv",
        severityLevel: "high",
        cvssScore: 7.5,
    }])).returning();

    const [withdrawn] = await db.insert(schema.vulnerabilities).values(withFindingIdentity([{
        vulnId: "GHSA-with-draw-0001",
        source: "osv",
        severityLevel: "critical",
        cvssScore: 9.8,
        withdrawnAt: WITHDRAWN_AT,
    }])).returning();

    await db.insert(schema.vulnerabilityAffectedPackages).values([
        {
            vulnerabilityId: active!.id,
            ecosystem: "npm",
            packageName: "lodash",
            matchKey: "npm/lodash",
            withdrawn: false,
            generation: 1,
        },
        {
            vulnerabilityId: withdrawn!.id,
            ecosystem: "npm",
            packageName: "lodash",
            matchKey: "npm/lodash",
            withdrawn: true,
            generation: 1,
        },
        // Drift: the advisory is retracted, this row still says otherwise.
        {
            vulnerabilityId: withdrawn!.id,
            ecosystem: "PyPI",
            packageName: "requests",
            matchKey: "pypi/requests",
            withdrawn: false,
            generation: 1,
        },
        // Same drift, superseded generation — must be invisible to every read.
        {
            vulnerabilityId: withdrawn!.id,
            ecosystem: "Go",
            packageName: "golang.org/x/net",
            matchKey: "golang/golang.org/x/net",
            withdrawn: false,
            generation: 2,
        },
    ]);

    await db.insert(schema.componentVulnerabilities).values([
        { componentId: component!.id, vulnerabilityId: active!.id, matchedBy: "purl", matchConfidence: "exact" },
        { componentId: component!.id, vulnerabilityId: withdrawn!.id, matchedBy: "purl", matchConfidence: "exact" },
    ]);

    return { db, component: component!, active: active!, withdrawn: withdrawn! };
}

describe("adminRepository.getWithdrawnStats", () => {
    it("counts findings still pointing at a retracted advisory, with their blast radius", async () => {
        await seedWithdrawnScenario();

        const stats = await adminRepository.getWithdrawnStats();

        expect(stats.advisories).toBe(1);
        // The match against the active advisory is not stale; the other one is.
        expect(stats.staleFindings).toEqual({ links: 1, components: 1, advisories: 1 });
    });

    it("counts affected-package rows whose withdrawn flag disagrees with the advisory", async () => {
        await seedWithdrawnScenario();

        const stats = await adminRepository.getWithdrawnStats();

        // The PyPI row only. The correctly-flagged npm row is not drift, and the
        // Go row is drift in a generation nothing reads.
        expect(stats.denormalizationDrift).toBe(1);
    });

    it("reads zero on a mirror with no retractions", async () => {
        const db = getTestDb();
        await db.insert(schema.vulnerabilities).values(withFindingIdentity([{
            vulnId: "CVE-2024-0002",
            source: "osv",
            severityLevel: "low",
        }]));

        const stats = await adminRepository.getWithdrawnStats();

        expect(stats).toEqual({
            advisories: 0,
            staleFindings: { links: 0, components: 0, advisories: 0 },
            denormalizationDrift: 0,
        });
    });
});

describe("admin mirror figures exclude withdrawn advisories", () => {
    it("excludes them from the advisory total and severity distribution", async () => {
        await seedWithdrawnScenario();

        const stats = await adminRepository.getVulnerabilityStats();

        expect(stats.total).toBe(1);
        expect(stats.withdrawn).toBe(1);
        // The retracted advisory is `critical`; counting it would have put a
        // critical bar on a chart of advisories nothing can match against.
        expect(stats.bySeverity).toEqual({ high: 1 });
    });

    it("counts affected-package entries by the flag the matcher actually reads", async () => {
        await seedWithdrawnScenario();

        const stats = await adminRepository.getVulnerabilityStats();

        // Two, not one: the active advisory's row plus the drifted row. The
        // drifted row *is* matchable — it is in the partial index — so counting
        // it here is the honest answer to "what can the matcher work with".
        // getWithdrawnStats().denormalizationDrift is what explains the gap.
        expect(stats.affectedPackagesTotal).toBe(2);
    });

    it("excludes them from the advisory ID distribution", async () => {
        await seedWithdrawnScenario();

        const distribution = await adminRepository.getAdvisoryIdDistribution();

        expect(distribution).toEqual([{ ecosystem: "CVE", count: 1 }]);
    });

    it("excludes correctly-flagged withdrawn rows from the ecosystem distribution", async () => {
        await seedWithdrawnScenario();

        const distribution = await adminRepository.getEcosystemDistribution();

        // npm from the active advisory and PyPI from the drifted row. The
        // correctly-flagged npm row of the retracted advisory is gone, and so is
        // the Go row in the superseded generation.
        expect(new Map(distribution.map((e) => [e.ecosystem, e.count]))).toEqual(
            new Map([["npm", 1], ["PyPI", 1]]),
        );
    });

    it("excludes them from the system stats shown on the Overview tab", async () => {
        await seedWithdrawnScenario();

        const stats = await adminRepository.getSystemStats();

        expect(stats.vulnerabilities.total).toBe(1);
        expect(stats.vulnerabilities.withdrawn).toBe(1);
        expect(stats.vulnerabilities.bySeverity).toEqual({ high: 1 });
        expect(stats.vulnerabilities.affectedPackagesTotal).toBe(2);
    });
});
