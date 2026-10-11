/**
 * The per-image rollup behind `GET /api/remediation/fixes`
 * (`remediation-rollup.service.ts`): the fixable / awaiting-fix / EOL split —
 * the two null-fix buckets must never collapse into "no fix available" — and
 * the rule that an image with nothing to act on is not a row.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let scenario: SeedTestScenarioResult;

async function rollup() {
    const { fixRollupForOrg } = await import("../../../src/services/remediation-rollup.service.js");
    return fixRollupForOrg(scenario.org.id);
}

async function advisory(vulnId: string, opts: { cvss?: number; severity?: string } = {}) {
    const db = getTestDb();
    const cvss = opts.cvss ?? 7.5;
    const [row] = await db
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId,
                    source: "osv",
                    cvssScore: cvss,
                    severityLevel: opts.severity ?? (cvss >= 9 ? "critical" : cvss >= 7 ? "high" : "medium"),
                    aliases: [],
                },
            ]),
        )
        .returning();
    return row!;
}

/** A matched finding with the provenance columns the Fix split reads. */
async function finding(
    sbomId: string,
    packageName: string,
    vulnerabilityId: string,
    opts: { fixedVersion?: string | null; matchedEcosystem?: string | null } = {},
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

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

describe("the fixes rollup", () => {
    it("splits null-fix findings into awaiting-fix and EOL, and never collapses them", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {
            repository: "library/nginx",
        });
        // Two workloads on one digest: one action, not two rows.
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image,
            workloadName: "web",
            namespace: "default",
            imageTag: "1.25.2",
        });
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, {
            image,
            workloadName: "proxy",
            namespace: "edge",
            imageTag: "1.25.2",
        });
        const sbom = await createSbom(db, { imageId: image.id });

        await finding(sbom.id, "libcrypto3", (await advisory("CVE-2024-0001")).id, {
            fixedVersion: "3.6.0-r0",
            matchedEcosystem: "Alpine:v3.16",
        });
        await finding(sbom.id, "zlib", (await advisory("CVE-2024-0002")).id, {
            fixedVersion: null,
            matchedEcosystem: "Alpine:v3.16", // EOL line
        });
        await finding(sbom.id, "left-pad", (await advisory("CVE-2024-0003")).id, {
            fixedVersion: null,
            matchedEcosystem: "npm", // no release line — awaiting
        });
        await finding(sbom.id, "busybox", (await advisory("CVE-2024-0004")).id, {
            fixedVersion: null,
            matchedEcosystem: null, // unknown — must not be claimed EOL
        });

        const res = await rollup();
        expect(res.rows).toHaveLength(1);

        const row = res.rows[0]!;
        expect(row.image.id).toBe(image.id);
        expect(row.workloadCount).toBe(2);
        expect(row.findings).toMatchObject({
            total: 4,
            fixable: 1,
            awaitingFix: 2,
            eol: 1,
        });
        expect(row.eolLines).toEqual([{ releaseLine: "Alpine 3.16", eolDate: "2024-05-23", findings: 1 }]);
        expect(res.totals.findings.eol).toBe(1);
    });

    it("does not list images with nothing to act on", async () => {
        const db = getTestDb();
        const image = await createImage(db, scenario.org.id, scenario.cluster.id, {});
        await seedRunningImage(db, scenario.org.id, scenario.cluster.id, { image });
        await createSbom(db, { imageId: image.id });

        const res = await rollup();
        expect(res.rows).toHaveLength(0);
    });
});
